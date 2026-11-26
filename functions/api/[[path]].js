/*
 * API di FitSup — Cloudflare Pages Functions + D1, sullo stesso indirizzo del sito (/api/...).
 *
 *   POST   /api/auth/register { email, password, name } → { pending, email }  (con email attive: arriva un codice)
 *                                                      → { token, user, recovery }  (senza invio email: come prima)
 *   POST   /api/auth/verify   { email, code }           → { token, user, recovery }  conferma dell'email col codice
 *   POST   /api/auth/resend   { email, purpose }        → { ok }  nuovo codice (purpose 'verify' | 'reset'), attesa 60 s
 *   POST   /api/auth/login    { email, password }       → { token, user }  | 403 { unverified } se l'email non è confermata
 *   POST   /api/auth/forgot   { email }                 → { ok, mail }  risposta uguale che l'email esista o no
 *   POST   /api/auth/reset    { email, code, password } → { token, user, recovery }  code = 6 cifre dall'email
 *                                                         oppure il codice di recupero XXXX-XXXX-XXXX-XXXX
 *   POST   /api/auth/google   { credential }  → { token, user }   accesso con Google (quando configurato)
 *
 * Email nel database (quando EMAIL_PEPPER ed EMAIL_KEY sono impostati):
 *   email_hash = HMAC-SHA256(EMAIL_PEPPER, email in minuscolo) → per cercare l'utente, mai l'email in chiaro
 *   email_enc  = AES-256-GCM(EMAIL_KEY, email)                 → decifrata solo per mandare un codice o mostrarla all'utente
 *   la vecchia colonna «email» contiene solo «h:<impronta>». Gli account esistenti si convertono da soli.
 * Invio dei codici: Brevo (BREVO_API_KEY + MAIL_FROM). Senza, la registrazione funziona come prima.
 *   GET    /api/me                            → { user }
 *   GET    /api/sync?since=ms                 → { now, docs }     cosa è cambiato dopo «since»
 *   POST   /api/sync          { docs }        → { now, saved }    salva i documenti cambiati
 *            (un invio è una sola transazione D1: report trimestrale e cancellazioni del registro passano insieme o per niente)
 *   POST   /api/logout                        → { ok }
 *   DELETE /api/account                       → { ok }            cancella l'utente e tutti i suoi dati
 *
 * Le richieste dopo l'accesso portano «Authorization: Bearer <token>».
 * Stesso indirizzo dell'app: niente CORS da gestire.
 */

const SESSION_DAYS = 180;
const MAX_SESSIONS = 10;          // accessi attivi per utente: oltre, si chiudono i più vecchi
const MAX_DOCS = 500;            // documenti per richiesta di salvataggio
const MAX_DOC_BYTES = 200_000;   // dimensione massima di un documento
const MAX_BODY = 3_000_000;      // dimensione massima di una richiesta
const QUOTA_DOCS = 20_000;       // documenti per utente (cancellati compresi)
const QUOTA_BYTES = 20_000_000;  // spazio per utente (20 MB)
const PULL_LIMIT = 2000;         // documenti per risposta di /sync: il resto arriva alla richiesta successiva
/* Limiti contro gli abusi (DoS, password a raffica, riempimento del database).
   Ogni regola: quante richieste, in quanti millisecondi. Contate in D1, tabella «limits». */
const LIMITS = {
  reg_ip:   [5, 3600e3],          // nuovi account per IP all'ora
  reg_all:  [300, 3600e3],        // nuovi account in tutto all'ora (freno d'emergenza se gli IP cambiano)
  auth_ip:  [30, 15 * 60e3],      // login e recupero password per IP ogni 15 minuti
  mail_e:   [5, 3600e3],          // codici inviati alla stessa email all'ora
  mail_ip:  [20, 3600e3],         // codici chiesti dallo stesso IP all'ora
  push_u:   [20_000, 864e5],      // documenti salvati per utente al giorno
  req_u:    [600, 3600e3],        // richieste di sincronizzazione per utente all'ora
};
const KINDS = new Set(['w', 'plan', 'mobx', 'pres', 'bk', 'qr']);  // bk = backup della scheda (max 2, nel documento), qr = report trimestrale
const GOOGLE_ISS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export async function onRequest({ request, env }) {
  try {
    return await route(request, env);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e && e.stack || e);
    return json({ error: status === 500 ? 'Errore del server' : e.message, ...(e && e.extra || {}) }, status);
  }
}

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  if (p !== '/') { await ensureTables(env); await housekeeping(env); }

  if (p === '/' && req.method === 'GET') return json({ ok: true, app: 'fitsup' });
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  if (p === '/auth/register' && req.method === 'POST') { await limit(env, 'reg_ip', ip); await limit(env, 'reg_all', 'all'); return register(req, env); }
  if (p === '/auth/login' && req.method === 'POST') { await limit(env, 'auth_ip', ip); return login(req, env); }
  if (p === '/auth/reset' && req.method === 'POST') { await limit(env, 'auth_ip', ip); return resetPassword(req, env); }
  if (p === '/auth/verify' && req.method === 'POST') { await limit(env, 'auth_ip', ip); return verifyEmail(req, env); }
  if (p === '/auth/resend' && req.method === 'POST') { await limit(env, 'mail_ip', ip); return resendCode(req, env); }
  if (p === '/auth/forgot' && req.method === 'POST') { await limit(env, 'mail_ip', ip); return forgot(req, env); }
  if (p === '/auth/google' && req.method === 'POST') { await limit(env, 'auth_ip', ip); return authGoogle(req, env); }

  const user = await requireUser(req, env);
  await limit(env, 'req_u', user.id);
  if (p === '/me' && req.method === 'GET') return json({ user: await publicUser(env, user) });
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
      env.DB.prepare('DELETE FROM limits WHERE k LIKE ?').bind('%:' + user.id),
      env.DB.prepare('DELETE FROM codes WHERE email_hash = ?').bind(user.email_hash || '-'),
      env.DB.prepare('DELETE FROM auth_fails WHERE email = ?').bind(user.email),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
    ]);
    return json({ ok: true });
  }
  throw new HttpError(404, 'Percorso inesistente');
}

/* L'email mostrata all'utente: decifrata da email_enc; negli account non ancora convertiti è nella colonna email. */
async function publicUser(env, u) {
  let email = '';
  if (u.email_enc && secure(env)) email = await emailDecrypt(env, u.email_enc).catch(() => '');
  else if (u.email && !u.email.startsWith('h:')) email = u.email;
  return { email, name: u.name || '' };
}

/* ---------- email: impronta, cifratura, invio dei codici ---------- */
/* EMAIL_PEPPER: segreto lungo e casuale per l'impronta (HMAC-SHA256). EMAIL_KEY: 32 byte in base64 per AES-256-GCM.
   Sono segreti dell'ambiente Cloudflare, mai nel codice né nel database. */
const secure = env => !!(env.EMAIL_PEPPER && env.EMAIL_KEY);
const mailOn = env => !!((env.BREVO_API_KEY && env.MAIL_FROM) || env.MAIL_LOG === '1');
const CODE_MIN = 15, CODE_TRIES = 5, RESEND_MS = 60e3;
let keyCache = null;
async function keys(env) {
  if (keyCache && keyCache.p === env.EMAIL_PEPPER && keyCache.k === env.EMAIL_KEY) return keyCache;
  const raw = Uint8Array.from(atob(env.EMAIL_KEY), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('EMAIL_KEY deve essere di 32 byte in base64');
  keyCache = {
    p: env.EMAIL_PEPPER, k: env.EMAIL_KEY,
    hmac: await crypto.subtle.importKey('raw', new TextEncoder().encode(env.EMAIL_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    aes: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']),
  };
  return keyCache;
}
async function hmacHex(env, s) {
  const sig = await crypto.subtle.sign('HMAC', (await keys(env)).hmac, new TextEncoder().encode(s));
  return bytesHex(new Uint8Array(sig));
}
const emailHash = (env, email) => hmacHex(env, 'email:' + email);
async function emailEncrypt(env, email) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, (await keys(env)).aes, new TextEncoder().encode(email)));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  return btoa(String.fromCharCode(...all));
}
async function emailDecrypt(env, enc) {
  const all = Uint8Array.from(atob(enc), c => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, (await keys(env)).aes, all.slice(12));
  return new TextDecoder().decode(pt);
}
/* «Chi è» un'email nel database: l'impronta quando la protezione è attiva, altrimenti l'email (vecchio modo). */
async function ident(env, email) { return secure(env) ? 'h:' + await emailHash(env, email) : email; }
const USER_COLS = 'id, email, email_hash, email_enc, verified, name, pass_hash, pass_salt, rec_hash';
async function findUser(env, email) {
  if (!secure(env)) return env.DB.prepare('SELECT id, email, NULL AS email_hash, NULL AS email_enc, 1 AS verified, name, pass_hash, pass_salt, rec_hash FROM users WHERE email = ?').bind(email).first();
  return env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE email_hash = ?`).bind(await emailHash(env, email)).first();
}

/* Codice a 6 cifre: salvato solo come impronta, scade in 15 minuti, 5 tentativi, nuovo invio dopo 60 secondi. */
async function codeHash(env, eh, purpose, code) { return hmacHex(env, 'code:' + purpose + ':' + eh + ':' + code); }
async function sendCode(env, eh, purpose, email) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT sent_at FROM codes WHERE email_hash = ? AND purpose = ?').bind(eh, purpose).first();
  if (row && now - row.sent_at < RESEND_MS) return false;       // appena mandato: niente doppioni
  await limit(env, 'mail_e', eh);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  await env.DB.prepare(
    `INSERT INTO codes (email_hash, purpose, code_hash, expires_at, tries, sent_at) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(email_hash, purpose) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0, sent_at = excluded.sent_at`
  ).bind(eh, purpose, await codeHash(env, eh, purpose, code), now + CODE_MIN * 60e3, now).run();
  const what = purpose === 'verify' ? 'confermare il tuo account FitSup' : 'impostare una nuova password su FitSup';
  await sendMail(env, email, 'FitSup: il tuo codice ' + code,
    `Il tuo codice per ${what} è ${code}.\n\nScade tra ${CODE_MIN} minuti. Se non sei stato tu, ignora questa email.`,
    `<p>Il tuo codice per ${what} è:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>Scade tra ${CODE_MIN} minuti. Se non sei stato tu, ignora questa email.</p>`);
  return true;
}
async function checkCode(env, eh, purpose, code) {
  const row = await env.DB.prepare('SELECT code_hash, expires_at, tries FROM codes WHERE email_hash = ? AND purpose = ?').bind(eh, purpose).first();
  if (!row || row.expires_at < Date.now()) throw new HttpError(400, 'Codice scaduto: chiedine uno nuovo');
  if (row.tries >= CODE_TRIES) throw new HttpError(429, 'Troppi tentativi: chiedi un nuovo codice');
  if (!sameHex(await codeHash(env, eh, purpose, String(code)), row.code_hash)) {
    await env.DB.prepare('UPDATE codes SET tries = tries + 1 WHERE email_hash = ? AND purpose = ?').bind(eh, purpose).run();
    const left = CODE_TRIES - row.tries - 1;
    throw new HttpError(400, left > 0 ? 'Codice non corretto: ' + (left === 1 ? 'ultimo tentativo' : 'ancora ' + left + ' tentativi') : 'Codice non corretto: chiedi un nuovo codice');
  }
  await env.DB.prepare('DELETE FROM codes WHERE email_hash = ? AND purpose = ?').bind(eh, purpose).run();
}
/* Invio con Brevo (API transazionale). L'email in chiaro esiste solo qui, per la durata della richiesta. */
async function sendMail(env, to, subject, text, html) {
  if (env.MAIL_LOG === '1') { console.log('[MAIL_LOG] a ' + to + ': ' + subject); return; }   // solo in locale, per le prove
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { name: env.MAIL_NAME || 'FitSup', email: env.MAIL_FROM }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
  });
  if (!r.ok) { console.error('invio email', r.status, (await r.text()).slice(0, 300)); throw new HttpError(502, 'Non riesco a mandare l’email adesso: riprova tra poco'); }
}
const cleanCode = v => String(v || '').replace(/\D/g, '');

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
/* auth_fails: una riga per email con errori recenti. «until» è la fine della finestra di 15 minuti:
   finché count < 8 conta gli errori, a 8 l'email resta bloccata fino a «until». Righe scadute: cancellate dalla pulizia. */
async function guardFails(env, email) {
  const row = await env.DB.prepare('SELECT count, until FROM auth_fails WHERE email = ?').bind(email).first();
  if (row && row.count >= MAX_FAILS && row.until > Date.now()) throw new HttpError(429, 'Troppi tentativi: riprova tra 15 minuti');
}
async function noteFail(env, email) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO auth_fails (email, count, until) VALUES (?1, 1, ?2)
     ON CONFLICT(email) DO UPDATE SET
       count = CASE WHEN auth_fails.until < ?3 THEN 1 ELSE auth_fails.count + 1 END,
       until = CASE WHEN auth_fails.until < ?3 THEN ?2 ELSE auth_fails.until END`
  ).bind(email, now + LOCK_MS, now).run();
}
async function newSession(env, user) {
  const now = Date.now(), token = randomToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), user.id, now, now + SESSION_DAYS * 864e5),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(user.id, now),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND token_hash NOT IN
      (SELECT token_hash FROM sessions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2)`).bind(user.id, MAX_SESSIONS),
  ]);
  return token;
}

/* Registrazione. Con l'invio email attivo l'account nasce «non confermato» e arriva un codice:
   senza conferma non si entra. Se l'email era già registrata ma mai confermata, si riparte da capo
   (nuova password, nuovo codice): il codice arriva solo a chi possiede davvero l'email. */
async function register(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email), pw = checkPassword(b.password);
  const name = String(b.name || '').trim().slice(0, 80);
  const verify = secure(env) && mailOn(env);
  const old = await findUser(env, email);
  if (old && (old.verified || !verify)) throw new HttpError(409, 'Esiste già un account con questa email: accedi');
  const { hash, salt } = await hashPassword(pw);
  if (old) {
    await env.DB.prepare('UPDATE users SET name = ?, pass_hash = ?, pass_salt = ? WHERE id = ?').bind(name, hash, salt, old.id).run();
    await sendCode(env, old.email_hash, 'verify', email);
    return json({ pending: true, email });
  }
  const user = { id: 'u' + randomToken().slice(0, 22), email, name };
  const id = await ident(env, email);
  if (verify) {
    const eh = id.slice(2);
    await env.DB.prepare('INSERT INTO users (id, email, email_hash, email_enc, verified, name, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)')
      .bind(user.id, id, eh, await emailEncrypt(env, email), name, hash, salt, Date.now()).run();
    await sendCode(env, eh, 'verify', email);
    return json({ pending: true, email });
  }
  const code = recoveryCode();
  if (secure(env)) await env.DB.prepare('INSERT INTO users (id, email, email_hash, email_enc, verified, name, pass_hash, pass_salt, rec_hash, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)')
    .bind(user.id, id, id.slice(2), await emailEncrypt(env, email), name, hash, salt, await sha256(code.replace(/-/g, '')), Date.now()).run();
  else await env.DB.prepare('INSERT INTO users (id, email, name, pass_hash, pass_salt, rec_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(user.id, email, name, hash, salt, await sha256(code.replace(/-/g, '')), Date.now()).run();
  return json({ token: await newSession(env, user), user: { email, name }, recovery: code });
}

/* Conferma dell'email: codice giusto → account attivo, si entra e si riceve il codice di recupero. */
async function verifyEmail(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email), code = cleanCode(b.code);
  if (!secure(env)) throw new HttpError(400, 'Conferma email non attiva');
  const u = await findUser(env, email);
  if (!u) throw new HttpError(400, 'Codice scaduto: chiedine uno nuovo');
  if (u.verified) throw new HttpError(409, 'Email già confermata: accedi');
  await checkCode(env, u.email_hash, 'verify', code);
  const rec = recoveryCode();
  await env.DB.prepare('UPDATE users SET verified = 1, rec_hash = ? WHERE id = ?').bind(await sha256(rec.replace(/-/g, '')), u.id).run();
  return json({ token: await newSession(env, u), user: await publicUser(env, u), recovery: rec });
}

/* Nuovo codice. Risponde sempre { ok: true }: così non si scopre quali email sono registrate. */
async function resendCode(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email), purpose = b.purpose === 'reset' ? 'reset' : 'verify';
  if (secure(env) && mailOn(env)) {
    const u = await findUser(env, email);
    if (u && (purpose === 'verify' ? !u.verified : u.verified)) await sendCode(env, u.email_hash, purpose, email).catch(e => { if (e.status !== 429) throw e; });
  }
  return json({ ok: true });
}
async function forgot(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email);
  if (!(secure(env) && mailOn(env))) return json({ ok: true, mail: false });   // si usa il codice di recupero
  const u = await findUser(env, email);
  if (u && u.verified) await sendCode(env, u.email_hash, 'reset', email).catch(e => { if (e.status !== 429) throw e; });
  return json({ ok: true, mail: true });
}

async function login(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email), pw = String(b.password || '');
  const fk = await ident(env, email);
  await guardFails(env, fk);
  const u = await findUser(env, email);
  const ok = u && u.pass_hash && sameHex((await hashPassword(pw, u.pass_salt)).hash, u.pass_hash);
  if (!ok) { await noteFail(env, fk); throw new HttpError(401, 'Email o password non corretti'); }
  await env.DB.prepare('DELETE FROM auth_fails WHERE email = ?').bind(fk).run();
  if (!u.verified) {
    if (mailOn(env)) await sendCode(env, u.email_hash, 'verify', email).catch(e => { if (e.status !== 429) throw e; });
    throw new HttpError(403, 'Conferma prima la tua email: ti abbiamo mandato un codice', { unverified: true, email });
  }
  return json({ token: await newSession(env, u), user: await publicUser(env, u) });
}

/* Nuova password: con il codice a 6 cifre arrivato per email oppure con il codice di recupero.
   Chiude tutti gli accessi aperti e dà un nuovo codice di recupero. */
async function resetPassword(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email), pw = checkPassword(b.password);
  const raw = String(b.code || '').trim();
  const fk = await ident(env, email);
  await guardFails(env, fk);
  const u = await findUser(env, email);
  if (/^\d{6}$/.test(raw.replace(/\s/g, ''))) {
    if (!u || !u.verified || !secure(env)) { await noteFail(env, fk); throw new HttpError(400, 'Codice scaduto: chiedine uno nuovo'); }
    await checkCode(env, u.email_hash, 'reset', cleanCode(raw));
  } else {
    const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!u || !u.rec_hash || !sameHex(await sha256(code), u.rec_hash)) { await noteFail(env, fk); throw new HttpError(401, 'Email o codice di recupero non corretti'); }
  }
  const { hash, salt } = await hashPassword(pw);
  const fresh = recoveryCode();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, rec_hash = ?, verified = 1 WHERE id = ?').bind(hash, salt, await sha256(fresh.replace(/-/g, '')), u.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    env.DB.prepare('DELETE FROM auth_fails WHERE email = ?').bind(fk),
  ]);
  return json({ token: await newSession(env, u), user: await publicUser(env, u), recovery: fresh });
}

/* ---------- accesso con Google (si attiva quando GOOGLE_CLIENT_ID è impostato) ---------- */

async function authGoogle(req, env) {
  const body = await readJson(req);
  const credential = typeof body.credential === 'string' ? body.credential : '';
  if (!credential) throw new HttpError(400, 'Manca il token di Google');
  const claims = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID);
  const email = String(claims.email).trim().toLowerCase();
  const id = await ident(env, email);
  let u = await env.DB.prepare('SELECT id, email, name FROM users WHERE google_sub = ? OR email = ?').bind(claims.sub, id).first();
  if (!u) {
    u = { id: 'u' + randomToken().slice(0, 22), email, name: claims.name || '' };
    if (secure(env)) await env.DB.prepare('INSERT INTO users (id, email, email_hash, email_enc, verified, name, google_sub, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
      .bind(u.id, id, id.slice(2), await emailEncrypt(env, email), u.name, claims.sub, Date.now()).run();
    else await env.DB.prepare('INSERT INTO users (id, email, name, google_sub, created_at) VALUES (?, ?, ?, ?, ?)').bind(u.id, email, u.name, claims.sub, Date.now()).run();
  } else await env.DB.prepare(secure(env) ? 'UPDATE users SET google_sub = ?, verified = 1 WHERE id = ?' : 'UPDATE users SET google_sub = ? WHERE id = ?').bind(claims.sub, u.id).run();
  return json({ token: await newSession(env, u), user: { email, name: u.name || '' } });   // Google ha già verificato l'email
}

async function requireUser(req, env) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(req.headers.get('Authorization') || '');
  if (!m) throw new HttpError(401, 'Accesso richiesto');
  const h = await sha256(m[1]);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, ${secure(env) ? 'u.email_hash, u.email_enc,' : ''} u.name, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id
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
     WHERE user_id = ? AND updated_at > ? ORDER BY updated_at LIMIT ?`
  ).bind(user.id, since, PULL_LIMIT).all();
  /* risposta piena: il resto arriva alla richiesta successiva. Il cursore torna indietro di 1 ms perché
     un salvataggio (max 500 documenti) ha un solo orario: qualche doppione, mai un documento perso. */
  const more = results.length === PULL_LIMIT;
  const next = more ? results[results.length - 1].updated_at - 1 : now;
  return json({
    now: next, more,
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
  if (stmts.length) {
    await limit(env, 'push_u', user.id, stmts.length);
    const q = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS b FROM docs WHERE user_id = ?').bind(user.id).first();
    const add = docs.reduce((t, d) => t + (d.deleted ? 0 : JSON.stringify(d.data ?? null).length), 0);
    if (q.n + docs.length > QUOTA_DOCS + MAX_DOCS || q.b + add > QUOTA_BYTES)
      throw new HttpError(507, 'Spazio dell’account esaurito: elimina vecchi allenamenti o scrivi al supporto');
    await env.DB.batch(stmts);
  }
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

/* ---------- limiti e pulizia ---------- */

let tablesReady = false;
async function ensureTables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS codes (email_hash TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, PRIMARY KEY (email_hash, purpose))`),
  ]);
  if (secure(env)) await migrateEmails(env);
  tablesReady = true;
}
/* Migrazione automatica (una volta per istanza): colonne nuove e conversione degli account con l'email in chiaro.
   Gli account già esistenti restano confermati (verified = 1). */
async function migrateEmails(env) {
  const { results } = await env.DB.prepare('PRAGMA table_info(users)').all();
  const has = new Set(results.map(c => c.name)), add = [];
  if (!has.has('email_hash')) add.push('ALTER TABLE users ADD COLUMN email_hash TEXT');
  if (!has.has('email_enc')) add.push('ALTER TABLE users ADD COLUMN email_enc TEXT');
  if (!has.has('verified')) add.push('ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 1');
  if (add.length) await env.DB.batch(add.map(s => env.DB.prepare(s)));
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS users_email_hash ON users(email_hash)').run();
  for (;;) {
    const { results: rows } = await env.DB.prepare("SELECT id, email FROM users WHERE email_hash IS NULL AND email NOT LIKE 'h:%' LIMIT 50").all();
    if (!rows.length) break;
    const st = [];
    for (const r of rows) {
      const e = String(r.email).trim().toLowerCase(), eh = await emailHash(env, e);
      st.push(env.DB.prepare('UPDATE users SET email = ?, email_hash = ?, email_enc = ? WHERE id = ?').bind('h:' + eh, eh, await emailEncrypt(env, e), r.id));
      st.push(env.DB.prepare('UPDATE OR IGNORE auth_fails SET email = ? WHERE email = ?').bind('h:' + eh, e));
    }
    await env.DB.batch(st);
  }
}
/* Conta n azioni per la chiave «regola:soggetto» nella finestra della regola; oltre il tetto risponde 429. Una sola scrittura. */
async function limit(env, rule, who, n = 1) {
  const [max, win] = LIMITS[rule], now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO limits (k, n, reset) VALUES (?1, ?2, ?3)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN limits.reset < ?4 THEN ?2 ELSE limits.n + ?2 END,
       reset = CASE WHEN limits.reset < ?4 THEN ?3 ELSE limits.reset END
     RETURNING n, reset`
  ).bind(rule + ':' + who, n, now + win, now).first();
  if (row && row.n > max) {
    const min = Math.max(1, Math.ceil((row.reset - now) / 60e3));
    throw new HttpError(429, 'Troppe richieste: riprova tra ' + min + (min === 1 ? ' minuto' : ' minuti'));
  }
}
/* Pulizia a campione (circa 1 richiesta su 200): righe scadute di limiti, tentativi sbagliati e sessioni. */
async function housekeeping(env) {
  if (Math.random() > 0.005) return;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM limits WHERE reset < ?').bind(now),
    env.DB.prepare('DELETE FROM auth_fails WHERE until < ?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM codes WHERE expires_at < ?').bind(now - 864e5),
  ]);
}

/* ---------- utilità ---------- */

async function readJson(req) {
  const len = +(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'Richiesta troppo grande');
  const t = await req.text();
  if (t.length > MAX_BODY) throw new HttpError(413, 'Richiesta troppo grande');
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
