BEGIN;
CREATE TABLE portfolio_private.audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid UNIQUE NOT NULL,
 actor_id uuid NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL,
 action text NOT NULL, request_payload jsonb NOT NULL, before_data jsonb, after_data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portfolio_private.audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portfolio_private.audit_events FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX audit_events_created ON portfolio_private.audit_events(created_at DESC);
ALTER TABLE public.projects ADD COLUMN revision bigint NOT NULL DEFAULT 0, ADD COLUMN deleted_at timestamptz,
 ADD COLUMN category text NOT NULL DEFAULT '', ADD COLUMN technologies text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.skills ADD COLUMN revision bigint NOT NULL DEFAULT 0, ADD COLUMN deleted_at timestamptz;
ALTER TABLE public.experiences ADD COLUMN revision bigint NOT NULL DEFAULT 0, ADD COLUMN deleted_at timestamptz;
ALTER TABLE public.education ADD COLUMN revision bigint NOT NULL DEFAULT 0, ADD COLUMN deleted_at timestamptz;
CREATE TABLE public.resumes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 160),
 filename text NOT NULL, storage_path text NOT NULL UNIQUE, sha256 text NOT NULL,
 file_size bigint NOT NULL CHECK(file_size BETWEEN 1 AND 10485760), is_active boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')), sort_order integer NOT NULL DEFAULT 0,
 revision bigint NOT NULL DEFAULT 1, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_resume ON public.resumes(is_active) WHERE is_active AND deleted_at IS NULL;
CREATE TABLE public.documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 160),
 project_id uuid REFERENCES public.projects(id), approved_for_chat boolean NOT NULL DEFAULT false,
 ingestion_status text NOT NULL DEFAULT 'uploaded' CHECK(ingestion_status IN ('uploaded','pending','processing','completed','failed')),
 desired_version uuid, desired_index uuid, active_version uuid, active_index uuid,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')), sort_order integer NOT NULL DEFAULT 0,
 revision bigint NOT NULL DEFAULT 1, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.project_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES public.projects(id),
 storage_path text NOT NULL UNIQUE, sha256 text NOT NULL, filename text NOT NULL, alt_text text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'published' CHECK(status IN ('draft','published','archived')), sort_order integer NOT NULL DEFAULT 0,
 revision bigint NOT NULL DEFAULT 1, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['projects','skills','experiences','education'] LOOP
  EXECUTE format('DROP POLICY published_content_read ON public.%I',t);
  EXECUTE format('CREATE POLICY published_content_read ON public.%I FOR SELECT TO anon,authenticated USING(status=''published'' AND deleted_at IS NULL)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['resumes','documents','project_assets'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION portfolio_private.touch_updated_at()',t);
 END LOOP;
END $$;
GRANT SELECT ON public.resumes,public.project_assets TO anon,authenticated;
CREATE POLICY active_resume_read ON public.resumes FOR SELECT TO anon,authenticated USING(is_active AND status='published' AND deleted_at IS NULL);
CREATE POLICY public_asset_read ON public.project_assets FOR SELECT TO anon,authenticated USING(status='published' AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM public.projects p WHERE p.id=project_id AND p.status='published' AND p.deleted_at IS NULL));
CREATE FUNCTION portfolio_private.catalog_columns(resource text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$ BEGIN
 RETURN CASE resource
 WHEN 'projects' THEN ARRAY['title','slug','summary','body_markdown','github_url','demo_url','is_featured','status','sort_order','category','technologies']
 WHEN 'skills' THEN ARRAY['name','category','description','status','sort_order']
 WHEN 'experiences' THEN ARRAY['company','job_title','location','started_on','ended_on','description_markdown','status','sort_order']
 WHEN 'education' THEN ARRAY['institution','qualification','field_of_study','started_on','ended_on','description_markdown','status','sort_order']
 WHEN 'resumes' THEN ARRAY['title','status','sort_order']
 WHEN 'documents' THEN ARRAY['title','project_id','approved_for_chat','status','sort_order']
 WHEN 'project_assets' THEN ARRAY['alt_text','status','sort_order'] ELSE NULL END;
END $$;
REVOKE ALL ON FUNCTION portfolio_private.catalog_columns(text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.admin_catalog_list(p_resource text,p_limit integer DEFAULT 100,p_offset integer DEFAULT 0,p_include_deleted boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE result jsonb; BEGIN
 PERFORM portfolio_private.require_admin_id();
 IF portfolio_private.catalog_columns(p_resource) IS NULL THEN RAISE EXCEPTION 'Invalid resource' USING ERRCODE='22023'; END IF;
 IF p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid pagination' USING ERRCODE='22023'; END IF;
 EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) FROM (SELECT * FROM public.%I WHERE (CASE WHEN $1 THEN deleted_at IS NOT NULL ELSE deleted_at IS NULL END) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3) t',p_resource) INTO result USING p_include_deleted,p_limit,p_offset;
 RETURN result;
END $$;
CREATE FUNCTION public.admin_catalog_mutate(p_resource text,p_id uuid,p_data jsonb,p_expected_revision bigint,p_request_id uuid,p_operation text DEFAULT 'save')
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=portfolio_private.require_admin_id(); allowed text[]; previous jsonb; result jsonb; receipt portfolio_private.audit_events%ROWTYPE;
 request jsonb:=jsonb_build_object('resource',p_resource,'id',p_id,'data',p_data,'revision',p_expected_revision,'operation',p_operation);
 columns_sql text; values_sql text; updates_sql text; extra_sql text; before_snapshot jsonb; old_active jsonb;
BEGIN
 allowed:=portfolio_private.catalog_columns(p_resource);
 IF allowed IS NULL THEN RAISE EXCEPTION 'Invalid resource' USING ERRCODE='22023'; END IF;
 IF p_request_id IS NULL OR p_operation NOT IN ('save','delete','restore','activate') OR p_expected_revision<0 OR jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid input' USING ERRCODE='22023'; END IF;
 IF (p_data-allowed)<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid fields' USING ERRCODE='22023'; END IF;
 IF p_resource='projects' AND p_operation='save' THEN
  IF length(p_data->>'title')>160 OR length(p_data->>'slug')>100 OR length(p_data->>'summary')>2000 OR length(p_data->>'body_markdown')>60000 OR length(p_data->>'category')>80 OR jsonb_array_length(coalesce(p_data->'technologies','[]'))>30 THEN RAISE EXCEPTION 'Invalid project fields' USING ERRCODE='22023'; END IF;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(682304,2);
 SELECT * INTO receipt FROM portfolio_private.audit_events WHERE request_id=p_request_id;
 IF FOUND THEN
  IF receipt.actor_id=actor AND receipt.request_payload=request THEN RETURN receipt.after_data; END IF;
  RAISE EXCEPTION 'Request ID already used' USING ERRCODE='40001';
 END IF;
 IF p_id IS NOT NULL THEN
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 FOR UPDATE',p_resource) INTO previous USING p_id;
  IF previous IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
  IF p_expected_revision IS NULL OR (previous->>'revision')::bigint<>p_expected_revision THEN RAISE EXCEPTION 'Content has changed' USING ERRCODE='40001'; END IF;
  IF previous->>'deleted_at' IS NOT NULL AND p_operation<>'restore' THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 ELSIF p_expected_revision IS NOT NULL OR p_operation<>'save' OR p_resource IN ('resumes','documents','project_assets') THEN
  RAISE EXCEPTION 'Invalid creation operation' USING ERRCODE='22023';
 END IF;
 before_snapshot:=previous;
 extra_sql:=CASE p_resource WHEN 'resumes' THEN ',is_active=false' WHEN 'documents' THEN ',approved_for_chat=false' ELSE '' END;
 IF p_operation='delete' THEN
  EXECUTE format('UPDATE public.%I t SET deleted_at=now(),status=''archived'',revision=revision+1%s WHERE id=$1 RETURNING to_jsonb(t)',p_resource,extra_sql) INTO result USING p_id;
 ELSIF p_operation='restore' THEN
  EXECUTE format('UPDATE public.%I t SET deleted_at=NULL,status=''draft'',revision=revision+1%s WHERE id=$1 RETURNING to_jsonb(t)',p_resource,extra_sql) INTO result USING p_id;
 ELSIF p_operation='activate' THEN
  IF p_resource<>'resumes' THEN RAISE EXCEPTION 'Invalid activation resource' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') INTO old_active FROM public.resumes r WHERE is_active;
  before_snapshot:=jsonb_build_object('target',previous,'previous_active',old_active);
  UPDATE public.resumes SET is_active=false,revision=revision+1 WHERE is_active AND id<>p_id;
  UPDATE public.resumes t SET is_active=true,status='published',revision=revision+1 WHERE id=p_id RETURNING to_jsonb(t) INTO result;
 ELSE
  IF p_data='{}'::jsonb THEN RAISE EXCEPTION 'Empty content' USING ERRCODE='22023'; END IF;
  SELECT string_agg(format('%I',key),','),string_agg(format('(jsonb_populate_record(NULL::public.%I,$1)).%I',p_resource,key),','),
   string_agg(format('%I=(jsonb_populate_record(NULL::public.%I,$1)).%I',key,p_resource,key),',')
   INTO columns_sql,values_sql,updates_sql FROM jsonb_object_keys(p_data) key;
  IF p_id IS NULL THEN
   EXECUTE format('INSERT INTO public.%I AS t (%s,revision) SELECT %s,1 RETURNING to_jsonb(t)',p_resource,columns_sql,values_sql) INTO result USING p_data;
  ELSE
   EXECUTE format('UPDATE public.%I AS t SET %s,revision=t.revision+1 WHERE id=$2 RETURNING to_jsonb(t)',p_resource,updates_sql) INTO result USING p_data,p_id;
  END IF;
 END IF;
 INSERT INTO portfolio_private.audit_events(request_id,actor_id,entity_type,entity_id,action,request_payload,before_data,after_data)
 VALUES(p_request_id,actor,p_resource,(result->>'id')::uuid,p_operation,request,before_snapshot,result);
 RETURN result;
END $$;
CREATE FUNCTION public.admin_activity(p_limit integer DEFAULT 30) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE result jsonb; BEGIN
 PERFORM portfolio_private.require_admin_id();
 SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') INTO result FROM (
 SELECT * FROM (SELECT id,created_at,actor_id,entity_type,entity_id,action FROM portfolio_private.audit_events
 UNION ALL SELECT id,created_at,actor_id,'profiles',profile_id,action FROM portfolio_private.content_audit_logs) all_events
 ORDER BY created_at DESC LIMIT least(greatest(p_limit,1),100)) t;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.admin_catalog_list(text,integer,integer,boolean),public.admin_catalog_mutate(text,uuid,jsonb,bigint,uuid,text),public.admin_activity(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_catalog_list(text,integer,integer,boolean),public.admin_catalog_mutate(text,uuid,jsonb,bigint,uuid,text),public.admin_activity(integer) TO authenticated;

CREATE FUNCTION public.admin_catalog_get(p_resource text,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE result jsonb; BEGIN
 PERFORM portfolio_private.require_admin_id();
 IF portfolio_private.catalog_columns(p_resource) IS NULL THEN RAISE EXCEPTION 'Invalid resource' USING ERRCODE='22023'; END IF;
 EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',p_resource) INTO result USING p_id;
 IF result IS NULL THEN RAISE EXCEPTION 'Record not found' USING ERRCODE='P0002'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.admin_catalog_get(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_catalog_get(text,uuid) TO authenticated;

COMMIT;
