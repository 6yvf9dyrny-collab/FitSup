/*
 * API di FitSup — Cloudflare Pages Functions + D1, sullo stesso indirizzo del sito (/api/...).
 *
 *   POST   /api/auth/register { email, password, name } → { token, user, recovery }
 *   POST   /api/auth/login    { email, password }       → { token, user }
 *   POST   /api/auth/reset    { email, code, password } → { token, user, recovery }  password dimenticata
 *   POST   /api/auth/google   { credential }  → { token, user }   accesso con Google (quando configurato)
 *   GET    /api/me                            → { user }
 *   GET    /api/sync?since=ms                 → { now, docs }     cosa è cambiato dopo «since»
 *   POST   /api/sync          { docs }        → { now, saved }    salva i documenti cambiati
 *   POST   /api/logout                        → { ok }
 *   DELETE /api/account                       → { ok }            cancella l'utente e tutti i suoi dati
 *
 * Le richieste dopo l'accesso portano «Authorization: Bearer <token>».
 * Stesso indirizzo dell'app: niente CORS da gestire.
 */

const SESSION_DAYS = 180;
const MAX_DOCS = 500;            // documenti per richiesta di salvataggio
const MAX_DOC_BYTES = 200_000;   // dimensione massima di un documento
const KINDS = new Set(['w', 'plan', 'mobx', 'pres']);
const GOOGLE_ISS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export async function onRequest({ request, env }) {
  try {
    return await route(request, env);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e && e.stack || e);
    return json({ error: status === 500 ? 'Errore del server' : e.message }, status);
  }
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';

  if (p === '/' && req.method === 'GET') return json({ ok: true, app: 'fitsup' });
  if (p === '/auth/register' && req.method === 'POST') return register(req, env);
  if (p === '/auth/login' && req.method === 'POST') return login(req, env);
  if (p === '/auth/reset' && req.method === 'POST') return resetPassword(req, env);
  if (p === '/auth/google' && req.method === 'POST') return authGoogle(req, env);

  const user = await requireUser(req, env);
  if (p === '/me' && req.method === 'GET') return json({ user: publicUser(user) });
  if (p === '/sync' && req.method === 'GET') return pull(url, env, user);
  if (p === '/sync' && req.method === 'POST') return push(req, env, user);
  if (p === '/logout' && req.method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.token_hash).run();
    return json({ ok: true });
  }
  if (p === '/account' && req.method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM docs WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
    ]);
    return json({ ok: true });
  }
  throw new HttpError(404, 'Percorso inesistente');
}

const publicUser = u => ({ email: u.email, name: u.name || '' });

/* ---------- accesso con email e password ---------- */
/* Password: PBKDF2-SHA256 con sale casuale (100.000 iterazioni, il massimo ammesso da Cloudflare).
   Codice di recupero: mostrato una volta alla registrazione, salvato solo come impronta.
   Tentativi sbagliati: dopo 8 errori l'email resta bloccata 15 minuti. */
const PBKDF2_ITER = 100000;
const MAX_FAILS = 8, LOCK_MS = 15 * 60e3;

function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (e.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new HttpError(400, 'Email non valida');
  return e;
}
function checkPassword(v) {
  const pw = String(v || '');
  if (pw.length < 8) throw new HttpError(400, 'La password deve avere almeno 8 caratteri');
  if (pw.length > 200) throw new HttpError(400, 'Password troppo lunga');
  return pw;
}
async function hashPassword(pw, saltHex) {
  const salt = saltHex ? hexBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return { hash: bytesHex(new Uint8Array(bits)), salt: bytesHex(salt) };
}
function sameHex(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function recoveryCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = crypto.getRandomValues(new Uint8Array(16));
  let c = ''; for (let i = 0; i < 16; i++) { c += abc[r[i] % abc.length]; if (i % 4 === 3 && i < 15) c += '-'; }
  return c;
}
async function guardFails(env, email) {
  const row = await env.DB.prepare('SELECT count, until FROM auth_fails WHERE email = ?').bind(email).first();
  if (row && row.until > Date.now()) throw new HttpError(429, 'Troppi tentativi: riprova tra 15 minuti');
}
async function noteFail(env, email) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT count FROM auth_fails WHERE email = ?').bind(email).first();
  const n = (row ? row.count : 0) + 1;
  await env.DB.prepare('INSERT INTO auth_fails (email, count, until) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET count = excluded.count, until = excluded.until')
    .bind(email, n >= MAX_FAILS ? 0 : n, n >= MAX_FAILS ? now + LOCK_MS : 0).run();
}
async function newSession(env, user) {
  const now = Date.now(), token = randomToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), user.id, now, now + SESSION_DAYS * 864e5),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(user.id, now),
  ]);
  return token;
}

async function register(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email), pw = checkPassword(b.password);
  const name = String(b.name || '').trim().slice(0, 80);
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first())
    throw new HttpError(409, 'Esiste già un account con questa email: accedi');
  const { hash, salt } = await hashPassword(pw);
  const code = recoveryCode();
  const user = { id: 'u' + randomToken().slice(0, 22), email, name };
  await env.DB.prepare('INSERT INTO users (id, email, name, pass_hash, pass_salt, rec_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(user.id, email, name, hash, salt, await sha256(code.replace(/-/g, '')), Date.now()).run();
  return json({ token: await newSession(env, user), user: publicUser(user), recovery: code });
}

async function login(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email), pw = String(b.password || '');
  await guardFails(env, email);
  const u = await env.DB.prepare('SELECT id, email, name, pass_hash, pass_salt FROM users WHERE email = ?').bind(email).first();
  const ok = u && u.pass_hash && sameHex((await hashPassword(pw, u.pass_salt)).hash, u.pass_hash);
  if (!ok) { await noteFail(env, email); throw new HttpError(401, 'Email o password non corretti'); }
  await env.DB.prepare('DELETE FROM auth_fails WHERE email = ?').bind(email).run();
  return json({ token: await newSession(env, u), user: publicUser(u) });
}

async function resetPassword(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email), pw = checkPassword(b.password);
  const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  await guardFails(env, email);
  const u = await env.DB.prepare('SELECT id, email, name, rec_hash FROM users WHERE email = ?').bind(email).first();
  if (!u || !u.rec_hash || !sameHex(await sha256(code), u.rec_hash)) { await noteFail(env, email); throw new HttpError(401, 'Email o codice di recupero non corretti'); }
  const { hash, salt } = await hashPassword(pw);
  const fresh = recoveryCode();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, rec_hash = ? WHERE id = ?').bind(hash, salt, await sha256(fresh.replace(/-/g, '')), u.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    env.DB.prepare('DELETE FROM auth_fails WHERE email = ?').bind(email),
  ]);
  return json({ token: await newSession(env, u), user: publicUser(u), recovery: fresh });
}

/* ---------- accesso con Google (si attiva quando GOOGLE_CLIENT_ID è impostato) ---------- */

async function authGoogle(req, env) {
  const body = await readJson(req);
  const credential = typeof body.credential === 'string' ? body.credential : '';
  if (!credential) throw new HttpError(400, 'Manca il token di Google');
  const claims = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID);
  const email = String(claims.email).toLowerCase();
  let u = await env.DB.prepare('SELECT id, email, name FROM users WHERE google_sub = ? OR email = ?').bind(claims.sub, email).first();
  if (!u) {
    u = { id: 'u' + randomToken().slice(0, 22), email, name: claims.name || '' };
    await env.DB.prepare('INSERT INTO users (id, email, name, google_sub, created_at) VALUES (?, ?, ?, ?, ?)').bind(u.id, email, u.name, claims.sub, Date.now()).run();
  } else await env.DB.prepare('UPDATE users SET google_sub = ? WHERE id = ?').bind(claims.sub, u.id).run();
  return json({ token: await newSession(env, u), user: publicUser(u) });
}

async function requireUser(req, env) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(req.headers.get('Authorization') || '');
  if (!m) throw new HttpError(401, 'Accesso richiesto');
  const h = await sha256(m[1]);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(h, Date.now()).first();
  if (!row) throw new HttpError(401, 'Sessione scaduta: accedi di nuovo');
  return row;
}

/* ---------- sincronizzazione ---------- */

async function pull(url, env, user) {
  const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT kind, id, data, updated_at, deleted FROM docs
     WHERE user_id = ? AND updated_at > ? ORDER BY updated_at LIMIT 5000`
  ).bind(user.id, since).all();
  return json({
    now,
    docs: results.map(r => ({ kind: r.kind, id: r.id, updated_at: r.updated_at, deleted: !!r.deleted, data: r.deleted ? null : safeParse(r.data) })),
  });
}

async function push(req, env, user) {
  const body = await readJson(req);
  const docs = Array.isArray(body.docs) ? body.docs : null;
  if (!docs) throw new HttpError(400, 'Formato non valido');
  if (docs.length > MAX_DOCS) throw new HttpError(413, 'Troppi documenti in una volta');
  const now = Date.now();
  const stmts = [];
  for (const d of docs) {
    if (!d || !KINDS.has(d.kind) || typeof d.id !== 'string' || !/^[\w.-]{1,80}$/.test(d.id)) throw new HttpError(400, 'Documento non valido');
    const deleted = d.deleted ? 1 : 0;
    const data = deleted ? null : JSON.stringify(d.data ?? null);
    if (data && data.length > MAX_DOC_BYTES) throw new HttpError(413, 'Documento troppo grande');
    stmts.push(env.DB.prepare(
      `INSERT INTO docs (user_id, kind, id, data, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted`
    ).bind(user.id, d.kind, d.id, data, now, deleted));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ now, saved: stmts.length });
}

/* ---------- token di Google: firma, destinatario, emittente, scadenza ---------- */

let jwksCache = { keys: null, until: 0 };

async function googleKeys(force) {
  if (!force && jwksCache.keys && Date.now() < jwksCache.until) return jwksCache.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new HttpError(503, 'Google non risponde, riprova');
  const maxAge = /max-age=(\d+)/.exec(r.headers.get('Cache-Control') || '');
  jwksCache = { keys: (await r.json()).keys, until: Date.now() + (maxAge ? +maxAge[1] * 1000 : 3600e3) };
  return jwksCache.keys;
}

async function verifyGoogleIdToken(token, clientId) {
  if (!clientId) throw new HttpError(503, 'Accesso con Google non ancora configurato');
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Token di Google non valido');
  const header = JSON.parse(b64urlText(parts[0]));
  const claims = JSON.parse(b64urlText(parts[1]));
  if (header.alg !== 'RS256') throw new HttpError(401, 'Token di Google non valido');

  let jwk = (await googleKeys(false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find(k => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, 'Token di Google non valido');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new HttpError(401, 'Token di Google non valido');

  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== clientId) throw new HttpError(401, 'Token destinato a un\'altra app');
  if (!GOOGLE_ISS.has(claims.iss)) throw new HttpError(401, 'Token di Google non valido');
  if (!claims.exp || claims.exp < now - 60) throw new HttpError(401, 'Accesso scaduto, riprova');
  if (!claims.sub || !claims.email || claims.email_verified === false) throw new HttpError(401, 'Email Google non verificata');
  return claims;
}

/* ---------- utilità ---------- */

async function readJson(req) {
  const t = await req.text();
  if (t.length > 3_000_000) throw new HttpError(413, 'Richiesta troppo grande');
  try { return JSON.parse(t || '{}'); } catch { throw new HttpError(400, 'JSON non valido'); }
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }
function randomToken() {
  const a = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesHex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }
function hexBytes(h) { return Uint8Array.from(h.match(/../g), x => parseInt(x, 16)); }
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
