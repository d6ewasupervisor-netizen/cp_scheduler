-- cp_scheduler auth allowlist (shared pattern with eod-api).
CREATE TABLE IF NOT EXISTS allowed_emails (
  email TEXT PRIMARY KEY,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_allowed_emails_updated_at ON allowed_emails(updated_at DESC);

INSERT INTO allowed_emails (email, note) VALUES
  ('d6ewa.supervisor@gmail.com', 'cp_scheduler rep-layer tester'),
  ('tgauthier2011@gmail.com', 'cp_scheduler admin'),
  ('bcampb9565@sbcglobal.net', 'cp_scheduler Central Pet rep (Brian Campbell)'),
  ('kimberlyjanellclaf@gmail.com', 'cp_scheduler Central Pet rep (Kimberly Claflin)')
ON CONFLICT (email) DO UPDATE SET
  note = EXCLUDED.note,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS link_requests (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  jti TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_link_requests_email ON link_requests(email);
CREATE INDEX IF NOT EXISTS idx_link_requests_jti ON link_requests(jti);
