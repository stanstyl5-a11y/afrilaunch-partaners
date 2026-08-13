-- ============================================================
-- AFRILAUNCH PARTNERS — Suivi des visites (pour le tableau de bord admin)
-- Coller dans : Supabase > SQL Editor > New query > Run
-- ============================================================

CREATE TABLE IF NOT EXISTS page_visits (
  id          BIGSERIAL PRIMARY KEY,
  page        TEXT        NOT NULL DEFAULT 'landing',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE page_visits ENABLE ROW LEVEL SECURITY;

-- N'importe quel visiteur peut enregistrer sa propre visite (anonyme, pas de donnée personnelle)
CREATE POLICY "allow_insert_anon" ON page_visits
  FOR INSERT TO anon WITH CHECK (true);

-- Seuls les admins peuvent lire le décompte des visites
CREATE POLICY "allow_select_admin" ON page_visits
  FOR SELECT TO authenticated USING (auth.uid() IN (SELECT user_id FROM admins));

CREATE INDEX IF NOT EXISTS idx_page_visits_created_at ON page_visits (created_at DESC);
