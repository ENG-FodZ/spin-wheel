
const path = require('path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// Trust Vercel proxy
app.set('trust proxy', 1);

// Middleware
app.use(express.json());

app.use(cookieSession({
  name: 'sw',
  keys: [process.env.SESSION_SECRET || 'dev-secret-change-this'],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));

// Database
const db = new DatabaseSync(
  process.env.DB_PATH || path.join(__dirname, 'data.db')
);

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    prize TEXT,
    spun_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Prizes
const PRIZES = [
  { label: '10% off', weight: 20 },
  { label: 'Buy 1 get 20% off 2nd', weight: 15 },
  { label: 'Free sample next order', weight: 20 },
  { label: 'Buy 2 get 40% off 3rd', weight: 5 },
  { label: 'Spin again', weight: 15, again: true },
  { label: 'Better luck next time', weight: 25 }
];

// Random prize selection
function pickPrize() {
  const total = PRIZES.reduce((sum, p) => sum + p.weight, 0);
  let random = crypto.randomInt(0, total);

  for (let i = 0; i < PRIZES.length; i++) {
    random -= PRIZES[i].weight;

    if (random < 0) {
      return i;
    }
  }

  return PRIZES.length - 1;
}

// Phone normalization
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

  return /^\+\d{9,15}$/.test(phone) ? phone : null;
}

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40
});

// ==================================
// PUBLIC FRONTEND
// ==================================

app.use(express.static(path.join(__dirname, 'public')));

// Homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================================
// API ROUTES
// ==================================

// Register player
app.post('/api/start', limiter, (req, res) => {
  const phone = normPhone(req.body.phone);

  if (!phone) {
    return res.status(400).json({
      error: 'Invalid phone number'
    });
  }

  db.prepare(
    'INSERT OR IGNORE INTO players(phone) VALUES(?)'
  ).run(phone);

  const player = db.prepare(
    'SELECT id FROM players WHERE phone=?'
  ).get(phone);

  req.session.uid = player.id;

  res.json({ ok: true });
});

// Current player
app.get('/api/me', (req, res) => {
  const user = req.session.uid &&
    db.prepare(
      'SELECT phone, prize FROM players WHERE id=?'
    ).get(req.session.uid);

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
});

// Spin wheel
app.post('/api/spin', limiter, (req, res) => {
  const uid = req.session.uid;

  const user = uid &&
    db.prepare(
      'SELECT * FROM players WHERE id=?'
    ).get(uid);

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

  const result = db.prepare(`
    UPDATE players
    SET prize=?, spun_at=datetime('now')
    WHERE id=? AND prize IS NULL
  `).run(prize.label, uid);

  if (!result.changes) {
    return res.status(403).json({
      error: 'This number already spun'
    });
  }

  res.json({
    index,
    label: prize.label,
    again: false
  });
});

// ==================================
// ADMIN AUTHENTICATION
// ==================================

function admin(req, res, next) {
  const authorization = req.headers.authorization || '';

  const encoded = authorization.split(' ')[1] || '';

  let username = '';
  let password = '';

  try {
    const decoded = Buffer.from(encoded, 'base64')
      .toString();

    const separator = decoded.indexOf(':');

    username = separator >= 0
      ? decoded.slice(0, separator)
      : '';

    password = separator >= 0
      ? decoded.slice(separator + 1)
      : '';
  } catch {
    username = '';
    password = '';
  }

  function safeCompare(a, b) {
    if (!a || !b || a.length !== b.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(a),
      Buffer.from(b)
    );
  }

  const valid =
    safeCompare(username, process.env.ADMIN_USER || '') &&
    safeCompare(password, process.env.ADMIN_PASS || '');

  if (valid) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Admin"');

  return res.status(401).send('Auth required');
}

// Admin dashboard
app.get('/admin', admin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Admin users
app.get('/api/admin/users', admin, (req, res) => {
  const users = db.prepare(`
    SELECT id, phone, prize, spun_at, created_at
    FROM players
    ORDER BY id DESC
  `).all();

  res.json(users);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path
  });
});

// Vercel serverless export
module.exports = app;

// Local development
if (require.main === module) {
  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log(`Running on http://localhost:${PORT}`);
  });
}
