-- Database di FitSup (Cloudflare D1, binding DB)

-- Utenti: uno per account Google. id = identificativo Google («sub»), non cambia mai.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  name       TEXT,
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
