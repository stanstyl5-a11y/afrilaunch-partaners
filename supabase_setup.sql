-- ============================================================
-- DUPLIK TUNNEL MONITOR — Setup Supabase
-- Coller dans : Supabase > SQL Editor > New query > Run
-- ============================================================

CREATE TABLE IF NOT EXISTS tunnel_events (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT        NOT NULL,
  event_data  JSONB       DEFAULT '{}',
  session_id  TEXT,
  device_type TEXT        DEFAULT 'unknown',
  browser     TEXT        DEFAULT 'unknown',
  referrer    TEXT        DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tunnel_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_insert_anon" ON tunnel_events
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "allow_select_anon" ON tunnel_events
  FOR SELECT TO anon USING (true);

CREATE INDEX IF NOT EXISTS idx_tunnel_events_created_at
  ON tunnel_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tunnel_events_type
  ON tunnel_events (event_type);
