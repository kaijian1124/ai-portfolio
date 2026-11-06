-- Initial public content schema. No personal data or sample content is inserted.
-- Apply once to the new ai-portfolio project. All changes are transactional.
BEGIN;

CREATE SCHEMA IF NOT EXISTS portfolio_private;
REVOKE ALL ON SCHEMA portfolio_private FROM PUBLIC, anon, authenticated;

CREATE FUNCTION portfolio_private.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION portfolio_private.touch_updated_at() FROM PUBLIC, anon, authenticated;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  headline text NOT NULL DEFAULT '',
  about_markdown text NOT NULL DEFAULT '',
  location text,
  public_email text,
  github_url text,
  linkedin_url text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.profiles IS 'Single-owner public profile. Every column of a published row is readable; never store private contacts here.';

CREATE TABLE public.skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  category text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  summary text NOT NULL DEFAULT '',
  body_markdown text NOT NULL DEFAULT '',
  github_url text,
  demo_url text,
  is_featured boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.experiences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (length(btrim(company)) > 0),
  job_title text NOT NULL CHECK (length(btrim(job_title)) > 0),
  location text,
  started_on date NOT NULL,
  ended_on date CHECK (ended_on >= started_on),
  description_markdown text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.experiences.ended_on IS 'NULL means ongoing. Dates are entered as calendar dates without timezone conversion.';

CREATE TABLE public.education (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution text NOT NULL CHECK (length(btrim(institution)) > 0),
  qualification text NOT NULL CHECK (length(btrim(qualification)) > 0),
  field_of_study text NOT NULL DEFAULT '',
  started_on date NOT NULL,
  ended_on date CHECK (ended_on >= started_on),
  description_markdown text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Explicit grants are required because automatic table exposure is disabled.
-- No browser-role writes, including TRUNCATE, are allowed at this milestone.
DO $$
DECLARE
  content_table text;
BEGIN
  FOREACH content_table IN ARRAY ARRAY['profiles', 'skills', 'projects', 'experiences', 'education']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', content_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', content_table);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO anon, authenticated', content_table);
    EXECUTE format(
      'CREATE POLICY published_content_read ON public.%I FOR SELECT TO anon, authenticated USING (status = ''published'')',
      content_table
    );
    EXECUTE format(
      'CREATE INDEX %I ON public.%I (sort_order, id) WHERE status = ''published''',
      content_table || '_published_order_idx', content_table
    );
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION portfolio_private.touch_updated_at()',
      content_table
    );
  END LOOP;
END;
$$;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

COMMIT;
