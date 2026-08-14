const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id SERIAL PRIMARY KEY,
      giveaway TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const GIVEAWAYS = {
  main: 'Main Giveaway (Yeti / Grills / Cornhole)',
  resident: '$300 or 3 Months Free (new residents, contingent on approval)',
};

app.post('/api/enter', async (req, res) => {
  try {
    const { giveaway, name, phone } = req.body || {};
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

    const dup = await pool.query(
      'SELECT 1 FROM entries WHERE phone = $1 AND giveaway = $2 LIMIT 1',
      [normalizedPhone, giveaway]
    );
    if (dup.rowCount > 0) {
      return res.status(409).json({ error: "You're already entered in this giveaway. Good luck!" });
    }

    await pool.query(
      'INSERT INTO entries (giveaway, name, phone) VALUES ($1, $2, $3)',
      [giveaway, cleanName, normalizedPhone]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).send('Forbidden');
  }
  next();
}

app.get('/admin', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM entries ORDER BY created_at DESC');
  const counts = { main: 0, resident: 0 };
  rows.forEach(r => { if (counts[r.giveaway] !== undefined) counts[r.giveaway]++; });
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
  <div class="card"><b>${counts.main}</b>Main Giveaway</div>
  <div class="card"><b>${counts.resident}</b>$300 / 3 Months Free</div>
  <div class="card"><b>${rows.length}</b>Total</div>
</div>
<a class="btn" href="/admin/export?key=${encodeURIComponent(req.query.key)}">Download CSV</a>
<table><tr><th>#</th><th>Giveaway</th><th>Name</th><th>Phone</th><th>Entered</th><th></th></tr>
${rows.map(r => `<tr><td>${r.id}</td><td>${esc(GIVEAWAYS[r.giveaway] || r.giveaway)}</td><td>${esc(r.name)}</td><td>${fmtPhone(r.phone)}</td><td>${new Date(r.created_at).toLocaleString('en-US',{timeZone:'America/Denver'})}</td><td><form method="post" action="/admin/delete?key=${encodeURIComponent(req.query.key)}" onsubmit="return confirm('Delete entry #${r.id}?')"><input type="hidden" name="id" value="${r.id}"><button style="background:#c53030;color:#fff;border:none;border-radius:6px;padding:.25rem .6rem;cursor:pointer">✕</button></form></td></tr>`).join('')}
</table></body></html>`);
});

app.post('/admin/delete', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM entries WHERE id = $1', [Number(req.body.id) || 0]);
  res.redirect(`/admin?key=${encodeURIComponent(req.query.key)}`);
});

app.get('/admin/export', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM entries ORDER BY created_at DESC');
  const csvEsc = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['id,giveaway,name,phone,entered_at'];
  rows.forEach(r => lines.push([r.id, csvEsc(GIVEAWAYS[r.giveaway] || r.giveaway), csvEsc(r.name), r.phone, r.created_at.toISOString()].join(',')));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="giveaway-entries.csv"');
  res.send(lines.join('\n'));
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Listening on ${PORT}`)))
  .catch(err => { console.error('DB init failed', err); process.exit(1); });
