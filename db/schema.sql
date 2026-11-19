-- Database di FitSup (Cloudflare D1, binding DB)

-- Utenti. Accesso con email e password (password mai salvata in chiaro: PBKDF2 con sale),
-- in futuro anche con Google (google_sub).
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  pass_hash  TEXT,
  pass_salt  TEXT,
  rec_hash   TEXT,              -- impronta del codice di recupero
  google_sub TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

-- Sessioni: si salva solo l'impronta (SHA-256) del codice di sessione, mai il codice.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Tentativi di accesso sbagliati, per bloccare chi prova password a raffica.
CREATE TABLE IF NOT EXISTS auth_fails (
  email TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  until INTEGER NOT NULL
);

-- Dati dell'app, un documento per riga:
--   kind = 'w' allenamento | 'plan' programmi | 'mobx' mobilità aggiunta | 'pres' presenze
--   updated_at = ora del server in millisecondi, serve alla sincronizzazione
--   deleted = 1 quando il documento è stato cancellato (resta per avvisare gli altri dispositivi)
CREATE TABLE IF NOT EXISTS docs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS docs_sync ON docs(user_id, updated_at);
