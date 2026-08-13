-- ============================================================
-- AFRILAUNCH PARTNERS — Script complet pour un nouveau projet Supabase
-- Coller dans : Supabase > SQL Editor > New query > Run
-- (Remplace les 3 anciens scripts : supabase_applications_setup.sql,
--  supabase_member_space_setup.sql, supabase_accounts_setup.sql)
-- ============================================================

-- 1) Candidatures partenaires — un compte candidat par ligne
CREATE TABLE IF NOT EXISTS applications (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID REFERENCES auth.users(id),
  first_name      TEXT        NOT NULL,
  last_name       TEXT        NOT NULL,
  whatsapp        TEXT        NOT NULL,
  email           TEXT,
  message         TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  affiliate_code  TEXT        UNIQUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ
);

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;

-- Le candidat crée sa propre ligne juste après avoir créé son compte (postuler.html)
CREATE POLICY "allow_insert_self" ON applications
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- Le candidat peut lire SA PROPRE candidature (pour connaître son statut)
CREATE POLICY "allow_select_self" ON applications
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_applications_created_at ON applications (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications (status);

-- 2) Admins — les seuls autorisés à voir/gérer TOUTES les candidatures
CREATE TABLE IF NOT EXISTS admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;

-- Chacun ne peut vérifier que SA PROPRE présence dans la table (nécessaire
-- pour que les policies ci-dessous fonctionnent correctement).
CREATE POLICY "allow_self_read" ON admins
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "allow_select_admin" ON applications
  FOR SELECT TO authenticated USING (auth.uid() IN (SELECT user_id FROM admins));

CREATE POLICY "allow_update_admin" ON applications
  FOR UPDATE TO authenticated
  USING (auth.uid() IN (SELECT user_id FROM admins))
  WITH CHECK (auth.uid() IN (SELECT user_id FROM admins));

-- 3) Leçons de l'espace membre — visibles par tout partenaire connecté
CREATE TABLE IF NOT EXISTS lessons (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  video_url   TEXT,
  position    INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE lessons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_select_authenticated" ON lessons
  FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_lessons_position ON lessons (position);

-- Leçons d'exemple — à remplacer par tes vraies formations (Table Editor > lessons)
INSERT INTO lessons (title, description, video_url, position) VALUES
  ('Bienvenue dans l''espace membre', 'Comment utiliser cet espace et ton lien d''affiliation personnel.', '', 1),
  ('Bâtir ta communauté', 'Les bases pour construire une audience qui te fait confiance.', '', 2),
  ('Attirer ta communauté vers Afrilaunch', 'Comment présenter ton lien d''affiliation pour convertir sans être insistant.', '', 3)
ON CONFLICT DO NOTHING;

-- ============================================================
-- ÉTAPES MANUELLES RESTANTES (pas du SQL) :
--
-- A. Authentication > Providers > Email > désactive "Confirm email"
--    (sinon la création de compte reste bloquée en attendant un clic
--    sur un email qu'on ne veut pas envoyer).
--
-- B. Authentication > Users > Add user > crée ton compte admin
--    (email + mot de passe de ton choix).
--
-- C. Copie son "User UID", puis exécute (en remplaçant TON-UID) :
--    INSERT INTO admins (user_id) VALUES ('TON-UID');
-- ============================================================
