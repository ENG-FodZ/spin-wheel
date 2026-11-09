
const path = require('path');
const express = require('express');
const { neon } = require('@neondatabase/serverless');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

app.set('trust proxy', 1);
app.use(express.json());

// ==================================
// ENVIRONMENT VALIDATION
// ==================================

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing');
}

if (
  process.env.NODE_ENV === 'production' &&
  !process.env.SESSION_SECRET
) {
  throw new Error('SESSION_SECRET is required');
}

if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.ADMIN_USER || !process.env.ADMIN_PASS)
) {
  throw new Error('ADMIN_USER and ADMIN_PASS are required');
}

// ==================================
// SESSION
// ==================================

app.use(cookieSession({
  name: 'sw',
  keys: [
    process.env.SESSION_SECRET || 'dev-secret-change-this'
  ],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));

// ==================================
// NEON DATABASE
// ==================================

const sql = neon(process.env.DATABASE_URL);

let dbReadyPromise;

async function ensureDatabase() {
  if (!dbReadyPromise) {
    dbReadyPromise = sql`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        prize TEXT,
        spun_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `.catch(error => {
      dbReadyPromise = null;
      throw error;
    });
  }

  await dbReadyPromise;
}

// Database initialization for API routes
app.use('/api', async (req, res, next) => {
  try {
    await ensureDatabase();
    next();
  } catch (error) {
    console.error('Database initialization failed:', error);

    res.status(503).json({
      error: 'Database unavailable'
    });
  }
});

// ==================================
// PRIZES
// ==================================

const PRIZES = [
  { label: '10% off', weight: 20 },
  { label: 'Buy 1 get 20% off 2nd', weight: 15 },
  { label: 'Free sample next order', weight: 20 },
  { label: 'Buy 2 get 40% off 3rd', weight: 5 },
  { label: 'Spin again', weight: 15, again: true },
  { label: 'Better luck next time', weight: 25 }
];

// ==================================
// RANDOM PRIZE
// ==================================

function pickPrize() {
  const total = PRIZES.reduce(
    (sum, prize) => sum + prize.weight,
    0
  );

  let random = crypto.randomInt(0, total);

  for (let i = 0; i < PRIZES.length; i++) {
    random -= PRIZES[i].weight;

    if (random < 0) {
      return i;
    }
  }

  return PRIZES.length - 1;
}

// ==================================
// PHONE NORMALIZATION
// ==================================

function normPhone(raw) {
  let phone = String(raw || '').replace(/[^\d+]/g, '');

  const cc = process.env.DEFAULT_COUNTRY_CODE || '20';

  if (phone.startsWith('00')) {
    phone = '+' + phone.slice(2);
  } else if (phone.startsWith('0')) {
    phone = '+' + cc + phone.slice(1);
  } else if (!phone.startsWith('+')) {
    phone = '+' + phone;
  }

  return /^\+\d{9,15}$/.test(phone)
    ? phone
    : null;
}

// ==================================
// RATE LIMITING
// ==================================

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false
});

// ==================================
// FRONTEND
// ==================================

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

// ==================================
// REGISTER PLAYER
// ==================================

app.post('/api/start', limiter, async (req, res, next) => {
  try {
    const phone = normPhone(req.body?.phone);

    if (!phone) {
      return res.status(400).json({
        error: 'Invalid phone number'
      });
    }

    await sql`
      INSERT INTO players (phone)
      VALUES (${phone})
      ON CONFLICT (phone) DO NOTHING
    `;

    const [player] = await sql`
      SELECT id
      FROM players
      WHERE phone = ${phone}
    `;

    if (!player) {
      return res.status(500).json({
        error: 'Could not register player'
      });
    }

    req.session.uid = player.id;

    res.json({ ok: true });

  } catch (error) {
    next(error);
  }
});

// ==================================
// CURRENT PLAYER
// ==================================

app.get('/api/me', async (req, res, next) => {
  try {
    const uid = req.session.uid;

    if (!uid) {
      return res.status(401).json({
        error: 'Not signed in'
      });
    }

    const [user] = await sql`
      SELECT phone, prize
      FROM players
      WHERE id = ${uid}
    `;

    if (!user) {
      return res.status(401).json({
        error: 'Not signed in'
      });
    }

    res.json({
      phone: user.phone,
      prize: user.prize,
      prizes: PRIZES.map(p => p.label)
    });

  } catch (error) {
    next(error);
  }
});

// ==================================
// SPIN WHEEL
// ==================================

app.post('/api/spin', limiter, async (req, res, next) => {
  try {
    const uid = req.session.uid;

    if (!uid) {
      return res.status(401).json({
        error: 'Not signed in'
      });
    }

    const [user] = await sql`
      SELECT id, prize
      FROM players
      WHERE id = ${uid}
    `;

    if (!user) {
      return res.status(401).json({
        error: 'Not signed in'
      });
    }

    if (user.prize) {
      return res.status(403).json({
        error: 'This number already spun',
        prize: user.prize
      });
    }

    const index = pickPrize();
    const prize = PRIZES[index];

    if (prize.again) {
      return res.json({
        index,
        label: prize.label,
        again: true
      });
    }

    // Atomic update prevents multiple winning spins
    const updated = await sql`
      UPDATE players
      SET prize = ${prize.label},
          spun_at = NOW()
      WHERE id = ${uid}
        AND prize IS NULL
      RETURNING id
    `;

    if (!updated.length) {
      return res.status(403).json({
        error: 'This number already spun'
      });
    }

    res.json({
      index,
      label: prize.label,
      again: false
    });

  } catch (error) {
    next(error);
  }
});

// ==================================
// ADMIN AUTHENTICATION
// ==================================

function safeCompare(a, b) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);

  return first.length > 0 &&
    first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

function askForLogin(res) {
  res.set('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('Auth required');
}

function admin(req, res, next) {
  const authorization = req.headers.authorization || '';

  const parts = authorization.split(' ');

  if (parts[0] !== 'Basic' || !parts[1]) {
    return askForLogin(res);
  }

  let decoded;

  try {
    decoded = Buffer.from(parts[1], 'base64').toString();
  } catch {
    return askForLogin(res);
  }

  const separator = decoded.indexOf(':');

  const username = separator >= 0
    ? decoded.slice(0, separator)
    : '';

  const password = separator >= 0
    ? decoded.slice(separator + 1)
    : '';

  const valid =
    safeCompare(username, process.env.ADMIN_USER || '') &&
    safeCompare(password, process.env.ADMIN_PASS || '');

  if (valid) {
    return next();
  }

  return askForLogin(res);
}

// ==================================
// ADMIN DASHBOARD
// ==================================

app.get('/admin', admin, (req, res) => {
  res.sendFile(
    path.join(__dirname, 'admin.html')
  );
});

// ==================================
// ADMIN PLAYERS
// ==================================

app.get('/api/admin/users', admin, async (req, res, next) => {
  try {
    const users = await sql`
      SELECT id, phone, prize, spun_at, created_at
      FROM players
      ORDER BY id DESC
    `;

    res.json(users);

  } catch (error) {
    next(error);
  }
});

// ==================================
// HEALTH CHECK
// ==================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok'
  });
});

// ==================================
// 404
// ==================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path
  });
});

// ==================================
// GLOBAL ERROR HANDLER
// ==================================

app.use((error, req, res, next) => {
  console.error('Server error:', error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: 'Internal server error'
  });
});

// ==================================
// VERCEL EXPORT
// ==================================

module.exports = app;

// ==================================
// LOCAL DEVELOPMENT
// ==================================

if (require.main === module) {
  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log(`Running on http://localhost:${PORT}`);
  });
}
