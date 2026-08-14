const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const EXTRA_ENTRY_PASSWORD = process.env.EXTRA_ENTRY_PASSWORD || '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

const TABLES = { main: 'entries_main', resident: 'entries_resident' };

async function initDb() {
  for (const table of Object.values(TABLES)) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        num_entries INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS email TEXT`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS interest TEXT`);
  }
  // One-time migration from the old combined table, if it still exists
  const legacy = await pool.query("SELECT to_regclass('public.entries') AS t");
  if (legacy.rows[0].t) {
    for (const [giveaway, table] of Object.entries(TABLES)) {
      await pool.query(
        `INSERT INTO ${table} (name, phone, num_entries, created_at)
         SELECT name, phone, COALESCE(num_entries, 1), created_at FROM entries WHERE giveaway = $1`,
        [giveaway]
      );
    }
    await pool.query('ALTER TABLE entries RENAME TO entries_legacy');
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const GIVEAWAYS = {
  main: 'Main Giveaway (Yeti Cooler / Blackstone / Igloo / Char-Griller Grill / Yeti Cup / Speaker)',
  resident: '3 First Full Months Free or $300 off for 6 Months (new residents, contingent on approval)',
};

app.post('/api/enter', async (req, res) => {
  try {
    const { giveaway, name, phone, email, interest, extra, staffPassword } = req.body || {};
    if (!GIVEAWAYS[giveaway]) {
      return res.status(400).json({ error: 'Please choose a giveaway.' });
    }
    const cleanName = String(name || '').trim();
    const digits = String(phone || '').replace(/\D/g, '');
    if (cleanName.length < 2) {
      return res.status(400).json({ error: 'Please enter your name.' });
    }
    if (digits.length < 10 || digits.length > 11) {
      return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }
    const normalizedPhone = digits.length === 11 ? digits.slice(1) : digits;
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!['Williston', 'Watford City'].includes(interest)) {
      return res.status(400).json({ error: 'Please pick Williston or Watford City.' });
    }

    let numEntries = 1;
    const extraCount = parseInt(extra, 10) || 0;
    if (extraCount > 0) {
      if (!EXTRA_ENTRY_PASSWORD || staffPassword !== EXTRA_ENTRY_PASSWORD) {
        return res.status(403).json({ error: 'Incorrect prize wheel password — ask the attendant and try again.' });
      }
      numEntries = Math.min(1 + extraCount, 5);
    }

    const table = TABLES[giveaway];
    const dup = await pool.query(
      `SELECT 1 FROM ${table} WHERE phone = $1 LIMIT 1`,
      [normalizedPhone]
    );
    if (dup.rowCount > 0) {
      return res.status(409).json({ error: "You're already entered in this giveaway. Good luck!" });
    }

    await pool.query(
      `INSERT INTO ${table} (name, phone, email, interest, num_entries) VALUES ($1, $2, $3, $4, $5)`,
      [cleanName, normalizedPhone, cleanEmail, interest, numEntries]
    );
    res.json({ ok: true, entries: numEntries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  if (req.query.key === ADMIN_KEY) return true;
  const cookies = String(req.headers.cookie || '');
  return cookies.split(';').some(c => {
    const [k, ...v] = c.trim().split('=');
    return k === 'admin' && decodeURIComponent(v.join('=')) === ADMIN_KEY;
  });
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).send('Forbidden');
  next();
}

const loginPage = (error) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login</title>
<style>
  body{font-family:system-ui,sans-serif;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(165deg,#0f2440,#16325c)}
  .box{background:#fff;border-radius:16px;padding:2rem;width:100%;max-width:340px;box-shadow:0 20px 50px rgba(0,0,0,.4)}
  h1{font-size:1.2rem;margin:0 0 1rem;color:#182233}
  input{width:100%;box-sizing:border-box;padding:.7rem .8rem;border:1.5px solid #e6e9ef;border-radius:10px;font-size:1rem;margin-bottom:.8rem}
  button{width:100%;padding:.75rem;border:none;border-radius:10px;background:#16325c;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
  .err{color:#b3352e;font-size:.85rem;margin:-.3rem 0 .7rem}
</style></head><body>
<form class="box" method="post" action="/admin/login">
  <h1>Giveaway Admin</h1>
  ${error ? '<div class="err">Incorrect password.</div>' : ''}
  <input type="password" name="password" placeholder="Password" autofocus required>
  <button type="submit">Sign In</button>
</form></body></html>`;

app.post('/admin/login', (req, res) => {
  if (ADMIN_KEY && (req.body.password || '') === ADMIN_KEY) {
    res.setHeader('Set-Cookie', `admin=${encodeURIComponent(ADMIN_KEY)}; HttpOnly; Secure; SameSite=Lax; Max-Age=43200; Path=/`);
    return res.redirect('/admin');
  }
  res.status(403).send(loginPage(true));
});

async function fetchAllEntries() {
  const rows = [];
  for (const [giveaway, table] of Object.entries(TABLES)) {
    const r = await pool.query(`SELECT * FROM ${table}`);
    r.rows.forEach(row => rows.push({ ...row, giveaway }));
  }
  rows.sort((a, b) => b.created_at - a.created_at);
  return rows;
}

app.get('/admin', async (req, res) => {
  if (!isAdmin(req)) return res.send(loginPage(false));
  const rows = await fetchAllEntries();
  const counts = { main: 0, resident: 0 };
  let totalEntries = 0;
  rows.forEach(r => {
    const n = r.num_entries || 1;
    if (counts[r.giveaway] !== undefined) counts[r.giveaway] += n;
    totalEntries += n;
  });
  const fmtPhone = p => p.length === 10 ? `(${p.slice(0,3)}) ${p.slice(3,6)}-${p.slice(6)}` : p;
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Giveaway Entries</title>
<style>
  body{font-family:system-ui,sans-serif;margin:2rem;background:#f6f7f9;color:#1a202c}
  h1{font-size:1.4rem} .cards{display:flex;gap:1rem;margin:1rem 0;flex-wrap:wrap}
  .card{background:#fff;border-radius:10px;padding:1rem 1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  .card b{font-size:1.6rem;display:block}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  th,td{padding:.6rem .9rem;text-align:left;border-bottom:1px solid #edf2f7;font-size:.9rem}
  th{background:#2d3748;color:#fff} tr:last-child td{border-bottom:none}
  a.btn{display:inline-block;margin:1rem 0;background:#2b6cb0;color:#fff;padding:.5rem 1rem;border-radius:8px;text-decoration:none}
</style></head><body>
<h1>Giveaway Entries</h1>
<div class="cards">
  <div class="card"><b>${counts.main}</b>Main Giveaway entries</div>
  <div class="card"><b>${counts.resident}</b>$300 / 3 Months Free entries</div>
  <div class="card"><b>${rows.length}</b>People</div>
  <div class="card"><b>${totalEntries}</b>Total entries</div>
</div>
<a class="btn" href="/admin/export">Download CSV</a>
<table><tr><th>#</th><th>Giveaway</th><th>Name</th><th>Phone</th><th>Email</th><th>Interest</th><th>Entries</th><th>Entered</th><th></th></tr>
${rows.map(r => `<tr><td>${r.id}</td><td>${esc(GIVEAWAYS[r.giveaway] || r.giveaway)}</td><td>${esc(r.name)}</td><td>${fmtPhone(r.phone)}</td><td>${esc(r.email || '')}</td><td>${esc(r.interest || '')}</td><td>${r.num_entries || 1}</td><td>${new Date(r.created_at).toLocaleString('en-US',{timeZone:'America/Denver'})}</td><td><form method="post" action="/admin/delete" onsubmit="return confirm('Delete entry #${r.id}?')"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="giveaway" value="${r.giveaway}"><button style="background:#c53030;color:#fff;border:none;border-radius:6px;padding:.25rem .6rem;cursor:pointer">✕</button></form></td></tr>`).join('')}
</table></body></html>`);
});

app.post('/admin/delete', requireAdmin, async (req, res) => {
  const table = TABLES[req.body.giveaway];
  if (table) {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [Number(req.body.id) || 0]);
  }
  res.redirect('/admin');
});

app.get('/admin/export', requireAdmin, async (req, res) => {
  const rows = await fetchAllEntries();
  const csvEsc = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['id,giveaway,name,phone,email,interest,entries,entered_at'];
  rows.forEach(r => lines.push([r.id, csvEsc(GIVEAWAYS[r.giveaway] || r.giveaway), csvEsc(r.name), r.phone, csvEsc(r.email || ''), csvEsc(r.interest || ''), r.num_entries || 1, r.created_at.toISOString()].join(',')));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="giveaway-entries.csv"');
  res.send(lines.join('\n'));
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Listening on ${PORT}`)))
  .catch(err => { console.error('DB init failed', err); process.exit(1); });
