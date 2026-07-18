-- cp_scheduler verbose shift audit log + carry-forward store notes.
-- Idempotent — safe to run repeatedly and at boot (see src/lib/shift-event-log.js ensureTables()).

-- One authoritative row per sealed/transmitted shift. draft_id is UNIQUE so the
-- seal -> transmit progression UPSERTs the same row (event_type advances,
-- visit_id/shift_id/transmitted_at fill in on transmit).
CREATE TABLE IF NOT EXISTS shift_events (
  id BIGSERIAL PRIMARY KEY,
  draft_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,            -- 'sealed' | 'transmitted'
  rep_key TEXT NOT NULL,
  rep_email TEXT,
  shift_date DATE NOT NULL,
  scheduled_store INT,
  actual_store INT NOT NULL,
  redirected BOOLEAN NOT NULL DEFAULT FALSE,
  visit_id BIGINT,
  shift_id BIGINT,
  processes TEXT,                      -- comma-joined: workLoad,writeOrder,picks
  start_actual TIMESTAMPTZ,
  stop_actual TIMESTAMPTZ,
  mileage_miles NUMERIC,
  outcome_summary TEXT,                -- '; '-joined labels where kind='outcome'
  variance_summary TEXT,               -- '; '-joined labels where kind='variance'
  custom_note TEXT,                    -- shiftLog.custom
  next_visit_note TEXT,                -- carry-forward note authored this shift
  stage_notes JSONB,                   -- { stepId: text }
  survey JSONB,
  payload JSONB,                       -- full draft snapshot for audit
  sealed_at TIMESTAMPTZ,
  transmitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shift_events_date ON shift_events(shift_date);
CREATE INDEX IF NOT EXISTS idx_shift_events_actual_store ON shift_events(actual_store);

-- Persistent, store-scoped handoff notes. Surfaced to the next rep who
-- services that store until resolved.
CREATE TABLE IF NOT EXISTS store_notes (
  id BIGSERIAL PRIMARY KEY,
  store INT NOT NULL,
  note TEXT NOT NULL,
  created_by_rep TEXT,
  created_from_draft TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_store_notes_active ON store_notes(store, resolved_at);
