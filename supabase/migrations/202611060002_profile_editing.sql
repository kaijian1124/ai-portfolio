-- Audited single-admin Profile writes through narrowly scoped RPCs.
-- No administrator identity or personal profile data is embedded in this migration.
BEGIN;

CREATE TABLE portfolio_private.admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portfolio_private.admin_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portfolio_private.admin_users FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.profiles
  ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0);

CREATE TABLE portfolio_private.content_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  actor_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('profile.create', 'profile.update')),
  request_payload jsonb NOT NULL,
  before_data jsonb,
  after_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN portfolio_private.content_audit_logs.actor_id IS 'Historical identity, intentionally retained even if an Auth account is deleted.';
ALTER TABLE portfolio_private.content_audit_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portfolio_private.content_audit_logs FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX profile_audit_created_idx ON portfolio_private.content_audit_logs (created_at DESC, id DESC);

CREATE FUNCTION portfolio_private.require_admin_id()
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  actor uuid := auth.uid();
BEGIN
  IF actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM portfolio_private.admin_users a WHERE a.user_id = actor
  ) THEN
    RAISE EXCEPTION 'Administrator access required' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END;
$$;
REVOKE ALL ON FUNCTION portfolio_private.require_admin_id() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.admin_get_profile()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  result jsonb;
BEGIN
  PERFORM portfolio_private.require_admin_id();
  SELECT to_jsonb(p) INTO result FROM public.profiles p WHERE p.singleton;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_get_profile() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_profile() TO authenticated;

CREATE FUNCTION public.admin_save_profile(
  p_profile jsonb,
  p_expected_revision bigint,
  p_request_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor uuid := portfolio_private.require_admin_id();
  allowed_keys text[] := ARRAY['display_name','headline','about_markdown','location','public_email','github_url','linkedin_url','status'];
  field_name text;
  field_value text;
  before_row public.profiles%ROWTYPE;
  saved_row public.profiles%ROWTYPE;
  previous_request portfolio_private.content_audit_logs%ROWTYPE;
  request_data jsonb := jsonb_build_object('profile', p_profile, 'expected_revision', p_expected_revision);
  normalized jsonb;
  before_snapshot jsonb;
  event_action text;
BEGIN
  IF p_request_id IS NULL OR p_expected_revision < 0
     OR jsonb_typeof(p_profile) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid profile input' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_profile ?& allowed_keys) OR (p_profile - allowed_keys) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid profile fields' USING ERRCODE = '22023';
  END IF;
  FOREACH field_name IN ARRAY ARRAY['display_name','headline','about_markdown','status'] LOOP
    IF jsonb_typeof(p_profile -> field_name) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid profile field type' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOREACH field_name IN ARRAY ARRAY['location','public_email','github_url','linkedin_url'] LOOP
    IF jsonb_typeof(p_profile -> field_name) NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Invalid profile field type' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF length(btrim(p_profile->>'display_name')) NOT BETWEEN 1 AND 120
     OR length(p_profile->>'headline') > 200
     OR length(p_profile->>'about_markdown') > 20000
     OR length(p_profile->>'location') > 120
     OR length(p_profile->>'public_email') > 254
     OR (p_profile->>'status') NOT IN ('draft','published','archived') THEN
    RAISE EXCEPTION 'Invalid profile value' USING ERRCODE = '22023';
  END IF;
  field_value := nullif(btrim(p_profile->>'public_email'), '');
  IF field_value IS NOT NULL AND field_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Invalid profile email' USING ERRCODE = '22023';
  END IF;
  FOREACH field_name IN ARRAY ARRAY['github_url','linkedin_url'] LOOP
    field_value := nullif(btrim(p_profile->>field_name), '');
    IF field_value IS NOT NULL AND (length(field_value) > 2048 OR field_value !~ '^https://[^/?#@[:space:]]+([/?#][^[:space:]]*)?$') THEN
      RAISE EXCEPTION 'Invalid profile URL' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  normalized := jsonb_build_object(
    'display_name', btrim(p_profile->>'display_name'),
    'headline', p_profile->>'headline',
    'about_markdown', p_profile->>'about_markdown',
    'location', nullif(btrim(p_profile->>'location'), ''),
    'public_email', nullif(btrim(p_profile->>'public_email'), ''),
    'github_url', nullif(btrim(p_profile->>'github_url'), ''),
    'linkedin_url', nullif(btrim(p_profile->>'linkedin_url'), ''),
    'status', p_profile->>'status'
  );

  -- Serialize singleton creation as well as updates. Lock is released on commit/rollback.
  PERFORM pg_catalog.pg_advisory_xact_lock(682304, 1);
  SELECT * INTO previous_request FROM portfolio_private.content_audit_logs WHERE request_id = p_request_id;
  IF FOUND THEN
    IF previous_request.actor_id = actor AND previous_request.request_payload = request_data THEN
      RETURN previous_request.after_data;
    END IF;
    RAISE EXCEPTION 'Request ID already used for another save' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO before_row FROM public.profiles WHERE singleton FOR UPDATE;
  IF FOUND THEN
    IF p_expected_revision IS NULL OR before_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'Profile has changed; reload before saving' USING ERRCODE = '40001';
    END IF;
    before_snapshot := to_jsonb(before_row);
    event_action := 'profile.update';
    UPDATE public.profiles SET
      display_name = normalized->>'display_name', headline = normalized->>'headline',
      about_markdown = normalized->>'about_markdown', location = normalized->>'location',
      public_email = normalized->>'public_email', github_url = normalized->>'github_url',
      linkedin_url = normalized->>'linkedin_url', status = normalized->>'status',
      revision = before_row.revision + 1
    WHERE id = before_row.id RETURNING * INTO saved_row;
  ELSE
    IF p_expected_revision IS NOT NULL THEN
      RAISE EXCEPTION 'Profile has changed; reload before saving' USING ERRCODE = '40001';
    END IF;
    event_action := 'profile.create';
    INSERT INTO public.profiles (
      display_name, headline, about_markdown, location, public_email,
      github_url, linkedin_url, status, revision
    ) VALUES (
      normalized->>'display_name', normalized->>'headline', normalized->>'about_markdown',
      normalized->>'location', normalized->>'public_email', normalized->>'github_url',
      normalized->>'linkedin_url', normalized->>'status', 1
    ) RETURNING * INTO saved_row;
  END IF;
  INSERT INTO portfolio_private.content_audit_logs (
    request_id, actor_id, profile_id, action, request_payload, before_data, after_data
  ) VALUES (
    p_request_id, actor, saved_row.id, event_action, request_data, before_snapshot, to_jsonb(saved_row)
  );
  RETURN to_jsonb(saved_row);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_save_profile(jsonb,bigint,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_save_profile(jsonb,bigint,uuid) TO authenticated;

-- Direct table writes stay revoked. All client-originated writes must pass the audited RPC.
COMMIT;
