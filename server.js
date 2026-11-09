const envPath = require('path').join(__dirname, '.env');
const envResult = require('dotenv').config({ path: envPath });
console.log('--- Settings check ---');
console.log('.env file:', envResult.error ? 'NOT FOUND or unreadable at ' + envPath : 'loaded from ' + envPath);
console.log('ADMIN_USER:', JSON.stringify(process.env.ADMIN_USER || null), '| ADMIN_PASS length:', (process.env.ADMIN_PASS || '').length);
console.log('----------------------');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieSession({
  name: 'sw', keys: [process.env.SESSION_SECRET || 'dev-secret'],
  maxAge: 7 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'data.db'));
db.exec(`CREATE TABLE IF NOT EXISTS players(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  prize TEXT,
  spun_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

// Prizes in wheel order. weight = chance. Edit freely.
const PRIZES = [
  { label: '10% off',                weight: 20 },
  { label: 'Buy 1 get 20% off 2nd',  weight: 15 },
  { label: 'Free sample next order', weight: 20 },
  { label: 'Buy 2 get 40% off 3rd',  weight: 5  },
  { label: 'Spin again',             weight: 15, again: true },
  { label: 'Better luck next time',  weight: 25 }
];
function pickPrize() {
  const total = PRIZES.reduce((s, p) => s + p.weight, 0);
  let r = crypto.randomInt(0, total * 100) / 100;
  for (let i = 0; i < PRIZES.length; i++) { if ((r -= PRIZES[i].weight) < 0) return i; }
  return PRIZES.length - 1;
}

// Normalise so 01001234567, +201001234567 and 00201001234567 are the SAME number.
function normPhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  const cc = process.env.DEFAULT_COUNTRY_CODE || '20';
  if (p.startsWith('00')) p = '+' + p.slice(2);
  else if (p.startsWith('0')) p = '+' + cc + p.slice(1);
  else if (!p.startsWith('+')) p = '+' + p;
  return /^\+\d{9,15}$/.test(p) ? p : null;
}

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });

app.post('/api/start', limiter, (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  db.prepare('INSERT OR IGNORE INTO players(phone) VALUES(?)').run(phone);
  req.session.uid = db.prepare('SELECT id FROM players WHERE phone=?').get(phone).id;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = req.session.uid && db.prepare('SELECT phone,prize FROM players WHERE id=?').get(req.session.uid);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  res.json({ phone: u.phone, prize: u.prize, prizes: PRIZES.map(p => p.label) });
});

app.post('/api/spin', limiter, (req, res) => {
  const uid = req.session.uid;
  const u = uid && db.prepare('SELECT * FROM players WHERE id=?').get(uid);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  if (u.prize) return res.status(403).json({ error: 'This number already spun', prize: u.prize });

  const index = pickPrize(), p = PRIZES[index];
  if (p.again) return res.json({ index, label: p.label, again: true });
  const r = db.prepare("UPDATE players SET prize=?, spun_at=datetime('now') WHERE id=? AND prize IS NULL").run(p.label, uid);
  if (!r.changes) return res.status(403).json({ error: 'This number already spun' });
  res.json({ index, label: p.label, again: false });
});

function admin(req, res, next) {
  const [u, p] = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':');
  const ok = (a, b) => a && b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (ok(u, process.env.ADMIN_USER || '') && ok(p, process.env.ADMIN_PASS || '')) return next();
  res.set('WWW-Authenticate', 'Basic realm="Admin"').status(401).send('Auth required');
}
app.get('/admin', admin, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/api/admin/users', admin, (req, res) =>
  res.json(db.prepare('SELECT id,phone,prize,spun_at,created_at FROM players ORDER BY id DESC').all()));

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('Running on http://localhost:' + (process.env.PORT || 3000)));
