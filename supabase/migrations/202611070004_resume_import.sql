BEGIN;
CREATE TABLE portfolio_private.resume_imports (
 id uuid PRIMARY KEY, resume_id uuid NOT NULL REFERENCES public.resumes(id),actor_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','completed','failed','applied')),
 candidates jsonb NOT NULL DEFAULT '[]', result jsonb,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portfolio_private.resume_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portfolio_private.resume_imports FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.admin_resume_import_begin(p_resume uuid,p_request uuid,p_budget numeric,p_reserve numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=portfolio_private.require_admin_id(); r portfolio_private.resume_imports%ROWTYPE;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(682304,6);
 SELECT * INTO r FROM portfolio_private.resume_imports WHERE id=p_request FOR UPDATE;
 IF FOUND THEN
  IF r.actor_id<>actor OR r.resume_id<>p_resume THEN RAISE EXCEPTION 'Request already used' USING ERRCODE='40001'; END IF;
  IF r.status='processing' AND r.created_at<now()-interval '2 minutes' THEN
   UPDATE portfolio_private.resume_imports SET status='failed',error='analysis_interrupted',updated_at=now() WHERE id=p_request RETURNING * INTO r;
   UPDATE portfolio_private.chat_requests SET status='failed',cost_usd=reserved_usd,error='resume_analysis_interrupted' WHERE id=p_request AND status='running';
  END IF;
  RETURN jsonb_build_object('claimed',false,'import',to_jsonb(r));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.resumes WHERE id=p_resume AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Resume not found' USING ERRCODE='P0002'; END IF;
 PERFORM public.chat_admit(p_request,p_request,'admin-resume-import',p_budget,p_reserve);
 INSERT INTO portfolio_private.resume_imports(id,resume_id,actor_id) VALUES(p_request,p_resume,actor) RETURNING * INTO r;
 RETURN jsonb_build_object('claimed',true,'import',to_jsonb(r));
END $$;
CREATE FUNCTION public.resume_import_finish(p_request uuid,p_candidates jsonb,p_prompt integer,p_output integer,p_cost numeric,p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE r portfolio_private.resume_imports%ROWTYPE; BEGIN
 IF jsonb_typeof(p_candidates) IS DISTINCT FROM 'array' OR jsonb_array_length(p_candidates)>50 OR length(p_candidates::text)>200000 THEN RAISE EXCEPTION 'Invalid candidates' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM portfolio_private.resume_imports WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Import not found' USING ERRCODE='P0002'; END IF;
 IF r.status<>'processing' THEN RETURN to_jsonb(r); END IF;
 UPDATE portfolio_private.resume_imports SET status=CASE WHEN p_error IS NULL THEN 'completed' ELSE 'failed' END,candidates=CASE WHEN p_error IS NULL THEN p_candidates ELSE '[]'::jsonb END,error=left(p_error,100),updated_at=now() WHERE id=p_request RETURNING * INTO r;
 UPDATE portfolio_private.chat_requests SET status=CASE WHEN p_error IS NULL THEN 'completed' ELSE 'failed' END,cost_usd=CASE WHEN p_error IS NULL THEN greatest(p_cost,0) ELSE reserved_usd END,prompt_tokens=greatest(p_prompt,0),output_tokens=greatest(p_output,0),error=left(p_error,100) WHERE id=p_request AND status='running';
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION public.admin_resume_import_get(p_resume uuid,p_request uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE actor uuid:=portfolio_private.require_admin_id(); r jsonb; BEGIN
 SELECT to_jsonb(t) INTO r FROM portfolio_private.resume_imports t WHERE id=p_request AND resume_id=p_resume AND actor_id=actor;
 IF r IS NULL THEN RAISE EXCEPTION 'Import not found' USING ERRCODE='P0002'; END IF;RETURN r;
END $$;
CREATE FUNCTION public.admin_resume_import_apply(p_resume uuid,p_request uuid,p_candidate_ids uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=portfolio_private.require_admin_id(); r portfolio_private.resume_imports%ROWTYPE; c jsonb; data jsonb; resource text; duplicate boolean; created jsonb:='[]'; skipped integer:=0; record jsonb; applied_result jsonb;
BEGIN
 SELECT * INTO r FROM portfolio_private.resume_imports WHERE id=p_request AND resume_id=p_resume AND actor_id=actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Import not found' USING ERRCODE='P0002'; END IF;
 IF r.status='applied' THEN RETURN r.result; END IF;
 IF r.status<>'completed' OR p_candidate_ids IS NULL OR array_position(p_candidate_ids,NULL) IS NOT NULL OR cardinality(p_candidate_ids) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Select completed candidates' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.resumes WHERE id=p_resume AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Resume withdrawn' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_candidate_ids) i WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.candidates) AS candidate(value) WHERE candidate.value->>'id'=i::text)) THEN RAISE EXCEPTION 'Invalid selection' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(682304,2);
 FOR c IN SELECT value FROM jsonb_array_elements(r.candidates) WHERE (value->>'id')::uuid=ANY(p_candidate_ids) LOOP
  resource:=c->>'resource';data:=(c->'data')||'{"status":"draft"}'::jsonb;
  IF resource NOT IN ('skills','projects','experiences','education') OR data ? 'id' OR data ? 'deleted_at' THEN RAISE EXCEPTION 'Invalid resource or fields' USING ERRCODE='22023'; END IF;
  IF resource='skills' THEN
   SELECT EXISTS(SELECT 1 FROM public.skills WHERE deleted_at IS NULL AND lower(btrim(name))=lower(btrim(data->>'name'))) INTO duplicate;
  ELSIF resource='projects' THEN
   SELECT EXISTS(SELECT 1 FROM public.projects WHERE (deleted_at IS NULL AND lower(btrim(title))=lower(btrim(data->>'title'))) OR slug=data->>'slug') INTO duplicate;
  ELSIF resource='experiences' THEN
   SELECT EXISTS(SELECT 1 FROM public.experiences WHERE deleted_at IS NULL AND lower(btrim(company))=lower(btrim(data->>'company')) AND lower(btrim(job_title))=lower(btrim(data->>'job_title')) AND started_on=(data->>'started_on')::date) INTO duplicate;
  ELSE
   SELECT EXISTS(SELECT 1 FROM public.education WHERE deleted_at IS NULL AND lower(btrim(institution))=lower(btrim(data->>'institution')) AND lower(btrim(qualification))=lower(btrim(data->>'qualification')) AND started_on=(data->>'started_on')::date) INTO duplicate;
  END IF;
  IF duplicate THEN skipped:=skipped+1;CONTINUE;END IF;
  record:=public.admin_catalog_mutate(resource,NULL,data,NULL,(c->>'id')::uuid,'save');
  created:=created||jsonb_build_array(jsonb_build_object('resource',resource,'id',record->>'id','title',coalesce(data->>'title',data->>'name',data->>'company',data->>'institution')));
 END LOOP;
 applied_result:=jsonb_build_object('status','applied','created',created,'skipped',skipped);
 UPDATE portfolio_private.resume_imports SET status='applied',result=applied_result,updated_at=now() WHERE id=p_request;
 RETURN applied_result;
END $$;
REVOKE ALL ON FUNCTION public.admin_resume_import_begin(uuid,uuid,numeric,numeric),public.admin_resume_import_get(uuid,uuid),public.admin_resume_import_apply(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_resume_import_begin(uuid,uuid,numeric,numeric),public.admin_resume_import_get(uuid,uuid),public.admin_resume_import_apply(uuid,uuid,uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.resume_import_finish(uuid,jsonb,integer,integer,numeric,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.resume_import_finish(uuid,jsonb,integer,integer,numeric,text) TO service_role;
COMMIT;
