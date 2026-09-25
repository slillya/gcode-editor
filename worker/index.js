// FeedFix Worker: serves the static site from ./public and keeps bug reports
// and feature requests in D1 (binding DB).
//
//   POST  .../api/reports       anyone: send a report
//   GET   .../api/reports       owner:  list reports      (Authorization: Bearer ADMIN_TOKEN)
//   GET   .../api/reports/:id   owner:  one report, with its attached program
//   PATCH .../api/reports/:id   owner:  set status to new, seen or done
//
// Secrets and variables: ADMIN_TOKEN (opens the inbox at /admin), optional
// REPORT_SALT (salts the hashed IPs used for rate limiting), optional BASE_PATH.

const LIMITS = { title: 200, details: 10000, contact: 200, context: 8000, fileName: 255, attachment: 512 * 1024 };
const BODY_LIMIT = 700 * 1024;
const PER_HOUR = 20;
const STATUSES = ['new', 'seen', 'done'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL,
    contact TEXT,
    context TEXT,
    attachment_name TEXT,
    attachment TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    ip_hash TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS reports_ip_time ON reports (ip_hash, created_at)'
];

const initialized = new WeakSet();

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (/\/api\/reports\/?$/.test(path)) {
      if (request.method === 'POST') return submit(request, env);
      if (request.method === 'GET') return list(request, env);
      return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST' });
    }
    const one = path.match(/\/api\/reports\/(\d+)\/?$/);
    if (one) {
      if (request.method === 'GET') return getOne(request, env, Number(one[1]));
      if (request.method === 'PATCH') return setStatus(request, env, Number(one[1]));
      return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, PATCH' });
    }
    return serveAsset(request, env, path);
  }
};

// Serves ./public. When the Worker is mounted under a path such as
// example.com/tools/feedfix/*, set the BASE_PATH variable to "/tools/feedfix".
function serveAsset(request, env, path) {
  if (!env.ASSETS) return new Response('Not found', { status: 404 });
  const base = (env.BASE_PATH || '').replace(/\/+$/, '');
  if (base && path === base) {
    const to = new URL(request.url);
    to.pathname = base + '/';
    return Response.redirect(to.toString(), 301);
  }
  if (base && path.startsWith(base + '/')) {
    const url = new URL(request.url);
    url.pathname = path.slice(base.length);
    return env.ASSETS.fetch(new Request(url.toString(), request));
  }
  return env.ASSETS.fetch(request);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
}

// Trims, drops control characters other than tab and newline, and caps length.
function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function init(env) {
  if (initialized.has(env.DB)) return;
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  initialized.add(env.DB);
}

async function submit(request, env) {
  if (!env.DB) return json({ error: 'Reports are not set up on this site yet.' }, 503);
  if (!(request.headers.get('content-type') || '').includes('application/json')) {
    return json({ error: 'Reports must be sent as JSON.' }, 415);
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: 'Reports are only accepted from this site.' }, 403);
  }
  const raw = await request.text();
  if (raw.length > BODY_LIMIT) return json({ error: 'The report is too large.' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'The report could not be read.' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'The report could not be read.' }, 400);
  if (body.website) return json({ ok: true, id: 0 }, 201);

  const kind = body.kind === 'bug' || body.kind === 'feature' ? body.kind : null;
  const title = clean(body.title, LIMITS.title);
  const details = clean(body.details, LIMITS.details);
  if (!kind || !title || !details) return json({ error: 'A report needs a type, a summary and details.' }, 400);
  const contact = clean(body.contact, LIMITS.contact) || null;
  let context = null;
  if (body.context && typeof body.context === 'object') context = JSON.stringify(body.context).slice(0, LIMITS.context);
  let fileName = null, attachment = null;
  if (body.attachment && typeof body.attachment.text === 'string') {
    if (body.attachment.text.length > LIMITS.attachment) {
      return json({ error: 'The attached program is over 512 KB. Send the report without it.' }, 413);
    }
    attachment = body.attachment.text;
    fileName = clean(body.attachment.name, LIMITS.fileName) || 'program.nc';
  }

  await init(env);
  const ipHash = hex(await sha256((request.headers.get('cf-connecting-ip') || 'unknown') + '|' + (env.REPORT_SALT || 'feedfix')));
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND created_at > ?').bind(ipHash, since).first();
  if (recent && recent.n >= PER_HOUR) {
    return json({ error: 'Too many reports from here in the last hour. Please try again later.' }, 429);
  }
  const result = await env.DB.prepare(
    'INSERT INTO reports (created_at, kind, title, details, contact, context, attachment_name, attachment, status, ip_hash) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(new Date().toISOString(), kind, title, details, contact, context, fileName, attachment, 'new', ipHash).run();
  return json({ ok: true, id: result.meta.last_row_id }, 201);
}

// Compares SHA-256 digests in constant time so the token can't be guessed byte by byte.
async function authorize(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: 'The report inbox is locked. Set the ADMIN_TOKEN secret on the Worker to open it.' }, 503);
  if (!env.DB) return json({ error: 'Reports are not set up on this site yet.' }, 503);
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = await sha256(given), b = await sha256(env.ADMIN_TOKEN);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return json({ error: 'Wrong inbox token.' }, 401);
  await init(env);
  return null;
}

async function list(request, env) {
  const denied = await authorize(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500);
  const { results } = await env.DB.prepare(
    'SELECT id, created_at, kind, title, details, contact, context, attachment_name, ' +
    'length(attachment) AS attachment_size, status FROM reports ORDER BY id DESC LIMIT ?'
  ).bind(limit).all();
  return json({ reports: results });
}

async function getOne(request, env, id) {
  const denied = await authorize(request, env);
  if (denied) return denied;
  const row = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'No report with that number.' }, 404);
  delete row.ip_hash;
  return json({ report: row });
}

async function setStatus(request, env, id) {
  const denied = await authorize(request, env);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch { body = null; }
  const status = body && STATUSES.includes(body.status) ? body.status : null;
  if (!status) return json({ error: 'Status must be new, seen or done.' }, 400);
  const result = await env.DB.prepare('UPDATE reports SET status = ? WHERE id = ?').bind(status, id).run();
  if (!result.meta.changes) return json({ error: 'No report with that number.' }, 404);
  return json({ ok: true, id, status });
}
