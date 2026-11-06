BEGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE TABLE portfolio_private.document_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),document_id uuid NOT NULL REFERENCES public.documents(id),
 filename text NOT NULL,storage_path text NOT NULL UNIQUE,sha256 text NOT NULL,file_size bigint NOT NULL,
 uploaded_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(document_id,sha256)
);
CREATE TABLE portfolio_private.ingestion_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),document_id uuid NOT NULL REFERENCES public.documents(id),
 version_id uuid NOT NULL REFERENCES portfolio_private.document_versions(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,next_retry_at timestamptz NOT NULL DEFAULT now(),
 error text,embedding_model text,chunk_count integer,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingestion_claim ON portfolio_private.ingestion_jobs(status,next_retry_at);
CREATE TABLE portfolio_private.document_chunks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),document_id uuid NOT NULL REFERENCES public.documents(id),
 version_id uuid NOT NULL REFERENCES portfolio_private.document_versions(id),index_id uuid NOT NULL REFERENCES portfolio_private.ingestion_jobs(id),
 ordinal integer NOT NULL,text_content text NOT NULL CHECK(length(text_content) BETWEEN 1 AND 2000),
 page integer,heading text,embedding extensions.vector(1536) NOT NULL,embedding_model text NOT NULL,
 UNIQUE(index_id,ordinal)
);
CREATE INDEX chunks_active_lookup ON portfolio_private.document_chunks(document_id,index_id);
CREATE TABLE portfolio_private.chat_sessions(id uuid PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE portfolio_private.chat_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),message_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,session_id uuid NOT NULL REFERENCES portfolio_private.chat_sessions(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('user','assistant')),content text NOT NULL,sources jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_history ON portfolio_private.chat_messages(session_id,created_at DESC);
CREATE TABLE portfolio_private.chat_requests (
 id uuid PRIMARY KEY,session_id uuid NOT NULL,ip_hash text NOT NULL,status text NOT NULL DEFAULT 'running',
 reserved_usd numeric NOT NULL,cost_usd numeric NOT NULL DEFAULT 0,prompt_tokens integer NOT NULL DEFAULT 0,
 output_tokens integer NOT NULL DEFAULT 0,embedding_tokens integer NOT NULL DEFAULT 0,latency_ms integer,
 error text,created_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz NOT NULL DEFAULT now()+interval '2 minutes'
);
CREATE INDEX chat_budget ON portfolio_private.chat_requests(created_at,status);
CREATE TABLE portfolio_private.chat_feedback (
 message_id uuid PRIMARY KEY REFERENCES portfolio_private.chat_messages(id) ON DELETE CASCADE,
 session_id uuid NOT NULL,vote integer NOT NULL CHECK(vote IN (-1,1)),created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['document_versions','ingestion_jobs','document_chunks','chat_sessions','chat_messages','chat_requests','chat_feedback'] LOOP
 EXECUTE format('ALTER TABLE portfolio_private.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON portfolio_private.%I FROM PUBLIC,anon,authenticated,service_role',t);
 END LOOP;
END $$;
CREATE FUNCTION public.admin_register_upload(p_kind text,p_title text,p_filename text,p_path text,p_sha256 text,p_size bigint,p_project_id uuid DEFAULT NULL,p_replace_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=portfolio_private.require_admin_id(); item_id uuid:=gen_random_uuid(); version_id uuid:=gen_random_uuid(); job_id uuid:=gen_random_uuid(); result jsonb; existing jsonb; old jsonb;
BEGIN
 IF p_kind NOT IN ('resume','knowledge','image') OR length(btrim(p_title)) NOT BETWEEN 1 AND 160 OR length(p_filename)>180 OR p_sha256 !~ '^[a-f0-9]{64}$' OR p_size NOT BETWEEN 1 AND 20971520
 OR p_path !~ '^[a-f0-9-]+/[a-f0-9-]+\.(pdf|docx|png|jpg|webp)$' THEN RAISE EXCEPTION 'Invalid upload metadata' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(682304,3);
 IF p_kind='resume' THEN
  IF p_size>10485760 OR p_path !~ '\.pdf$' THEN RAISE EXCEPTION 'Invalid resume' USING ERRCODE='22023'; END IF;
  SELECT to_jsonb(r) INTO existing FROM public.resumes r WHERE sha256=p_sha256 AND deleted_at IS NULL LIMIT 1;
  IF existing IS NOT NULL THEN RETURN jsonb_build_object('record',existing,'duplicate',true); END IF;
  INSERT INTO public.resumes(id,title,filename,storage_path,sha256,file_size) VALUES(item_id,p_title,p_filename,p_path,p_sha256,p_size) RETURNING to_jsonb(resumes) INTO result;
 ELSIF p_kind='image' THEN
  SELECT to_jsonb(a) INTO existing FROM public.project_assets a WHERE sha256=p_sha256 AND project_id=p_project_id AND deleted_at IS NULL LIMIT 1;
  IF existing IS NOT NULL THEN RETURN jsonb_build_object('record',existing,'duplicate',true); END IF;
  IF p_size>4194304 OR p_path !~ '\.(png|jpg|webp)$' OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project_id AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Invalid project image' USING ERRCODE='22023'; END IF;
  INSERT INTO public.project_assets(id,project_id,storage_path,sha256,filename,alt_text) VALUES(item_id,p_project_id,p_path,p_sha256,p_filename,p_title) RETURNING to_jsonb(project_assets) INTO result;
 ELSE
  IF p_path !~ '\.(pdf|docx)$' THEN RAISE EXCEPTION 'Invalid knowledge file' USING ERRCODE='22023'; END IF;
  IF p_replace_id IS NOT NULL THEN
   SELECT to_jsonb(d) INTO old FROM public.documents d WHERE id=p_replace_id AND deleted_at IS NULL FOR UPDATE;
   IF old IS NULL THEN RAISE EXCEPTION 'Document not found' USING ERRCODE='P0002'; END IF;
   item_id:=p_replace_id;
  END IF;
  SELECT to_jsonb(d) INTO existing FROM public.documents d JOIN portfolio_private.document_versions v ON v.document_id=d.id
   WHERE v.sha256=p_sha256 AND d.deleted_at IS NULL AND (p_replace_id IS NULL OR d.id=p_replace_id) LIMIT 1;
  IF existing IS NOT NULL THEN RETURN jsonb_build_object('record',existing,'duplicate',true); END IF;
  IF p_replace_id IS NULL THEN INSERT INTO public.documents(id,title,project_id) VALUES(item_id,p_title,p_project_id); END IF;
  INSERT INTO portfolio_private.document_versions(id,document_id,filename,storage_path,sha256,file_size,uploaded_by)
  VALUES(version_id,item_id,p_filename,p_path,p_sha256,p_size,actor);
  UPDATE public.documents SET desired_version=version_id,desired_index=job_id,approved_for_chat=false,ingestion_status='pending',revision=revision+1 WHERE id=item_id RETURNING to_jsonb(documents) INTO result;
  INSERT INTO portfolio_private.ingestion_jobs(id,document_id,version_id) VALUES(job_id,item_id,version_id);
 END IF;
 INSERT INTO portfolio_private.audit_events(request_id,actor_id,entity_type,entity_id,action,request_payload,before_data,after_data)
 VALUES(version_id,actor,CASE p_kind WHEN 'resume' THEN 'resumes' WHEN 'image' THEN 'project_assets' ELSE 'documents' END,item_id,'upload',jsonb_build_object('sha256',p_sha256),old,result);
 RETURN jsonb_build_object('record',result,'duplicate',false);
END $$;
CREATE FUNCTION public.admin_document_versions(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE result jsonb; BEGIN
 PERFORM portfolio_private.require_admin_id();
 SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') INTO result FROM (SELECT v.id,v.filename,v.created_at,v.file_size,
  (SELECT jsonb_build_object('status',j.status,'attempts',j.attempts,'error',j.error,'chunk_count',j.chunk_count) FROM portfolio_private.ingestion_jobs j WHERE j.version_id=v.id ORDER BY j.created_at DESC LIMIT 1) AS processing
 FROM portfolio_private.document_versions v WHERE v.document_id=p_id ORDER BY v.created_at DESC) t;
 RETURN result;
END $$;
CREATE FUNCTION public.admin_reindex_document(p_id uuid,p_request_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=portfolio_private.require_admin_id(); d public.documents%ROWTYPE; result jsonb;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(682304,3);
 SELECT * INTO d FROM public.documents WHERE id=p_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR d.desired_version IS NULL THEN RAISE EXCEPTION 'Document not found' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM portfolio_private.ingestion_jobs WHERE id=p_request_id AND document_id=p_id) THEN RETURN jsonb_build_object('queued',true); END IF;
 INSERT INTO portfolio_private.ingestion_jobs(id,document_id,version_id) VALUES(p_request_id,p_id,d.desired_version);
 UPDATE public.documents SET ingestion_status='pending',desired_index=p_request_id WHERE id=p_id;
 result:=jsonb_build_object('queued',true,'job_id',p_request_id);
 INSERT INTO portfolio_private.audit_events(request_id,actor_id,entity_type,entity_id,action,request_payload,after_data) VALUES(p_request_id,actor,'documents',p_id,'reindex','{}',result);
 RETURN result;
END $$;
CREATE FUNCTION public.admin_file_info(p_resource text,p_id uuid,p_version_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE result jsonb; BEGIN
 PERFORM portfolio_private.require_admin_id();
 IF p_resource='resumes' THEN SELECT jsonb_build_object('bucket','portfolio-resumes','path',storage_path,'filename',filename) INTO result FROM public.resumes WHERE id=p_id AND deleted_at IS NULL;
 ELSIF p_resource='documents' THEN SELECT jsonb_build_object('bucket','portfolio-knowledge','path',v.storage_path,'filename',v.filename) INTO result FROM public.documents d JOIN portfolio_private.document_versions v ON v.document_id=d.id AND v.id=coalesce(p_version_id,d.desired_version) WHERE d.id=p_id AND d.deleted_at IS NULL;
 ELSE RAISE EXCEPTION 'Invalid resource' USING ERRCODE='22023'; END IF;
 IF result IS NULL THEN RAISE EXCEPTION 'File not found' USING ERRCODE='P0002'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.admin_register_upload(text,text,text,text,text,bigint,uuid,uuid),public.admin_document_versions(uuid),public.admin_reindex_document(uuid,uuid),public.admin_file_info(text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_register_upload(text,text,text,text,text,bigint,uuid,uuid),public.admin_document_versions(uuid),public.admin_reindex_document(uuid,uuid),public.admin_file_info(text,uuid,uuid) TO authenticated;
CREATE FUNCTION public.worker_claim_job() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE j portfolio_private.ingestion_jobs%ROWTYPE; result jsonb; BEGIN
 UPDATE portfolio_private.ingestion_jobs x SET status='cancelled' FROM public.documents d WHERE x.document_id=d.id AND x.status IN ('pending','failed','processing') AND (d.deleted_at IS NOT NULL OR d.desired_version<>x.version_id OR d.desired_index<>x.id);
 UPDATE portfolio_private.ingestion_jobs SET status='failed',error='lease_expired_after_max_attempts',updated_at=now() WHERE status='processing' AND lease_until<now() AND attempts>=3;
 UPDATE public.documents d SET ingestion_status='failed' FROM portfolio_private.ingestion_jobs expired_job WHERE expired_job.document_id=d.id AND expired_job.version_id=d.desired_version AND expired_job.id=d.desired_index AND expired_job.status='failed' AND expired_job.attempts>=3;
 SELECT * INTO j FROM portfolio_private.ingestion_jobs WHERE attempts<3 AND next_retry_at<=now() AND (status IN ('pending','failed') OR (status='processing' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE portfolio_private.ingestion_jobs SET status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',updated_at=now(),error=NULL WHERE id=j.id RETURNING * INTO j;
 UPDATE public.documents SET ingestion_status='processing' WHERE id=j.document_id;
 DELETE FROM portfolio_private.document_chunks WHERE index_id=j.id;
 SELECT to_jsonb(j)||jsonb_build_object('storage_path',v.storage_path,'filename',v.filename,'sha256',v.sha256,'title',d.title) INTO result FROM portfolio_private.document_versions v JOIN public.documents d ON d.id=v.document_id WHERE v.id=j.version_id;
 RETURN result;
END $$;
CREATE FUNCTION public.worker_store_chunks(p_job uuid,p_lease uuid,p_chunks jsonb,p_model text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE j portfolio_private.ingestion_jobs%ROWTYPE; c jsonb; n integer:=0; BEGIN
 SELECT * INTO j FROM portfolio_private.ingestion_jobs WHERE id=p_job AND lease_token=p_lease AND status='processing' AND lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job lease expired' USING ERRCODE='40001'; END IF;
 IF jsonb_typeof(p_chunks)<>'array' OR jsonb_array_length(p_chunks)>64 THEN RAISE EXCEPTION 'Invalid chunk batch' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.documents WHERE id=j.document_id AND deleted_at IS NULL AND desired_version=j.version_id AND desired_index=j.id) THEN RAISE EXCEPTION 'Document withdrawn or superseded' USING ERRCODE='40001'; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p_chunks) LOOP
  IF (c->>'ordinal')::integer<0 OR jsonb_array_length(c->'embedding')<>1536 THEN RAISE EXCEPTION 'Invalid chunk' USING ERRCODE='22023'; END IF;
  INSERT INTO portfolio_private.document_chunks(document_id,version_id,index_id,ordinal,text_content,page,heading,embedding,embedding_model)
  VALUES(j.document_id,j.version_id,j.id,(c->>'ordinal')::integer,c->>'text',(c->>'page')::integer,left(c->>'heading',200),(c->'embedding')::text::extensions.vector(1536),p_model)
  ON CONFLICT(index_id,ordinal) DO UPDATE SET text_content=excluded.text_content,page=excluded.page,heading=excluded.heading,embedding=excluded.embedding,embedding_model=excluded.embedding_model;
  n:=n+1;
 END LOOP;
 UPDATE portfolio_private.ingestion_jobs SET lease_until=now()+interval '10 minutes',updated_at=now() WHERE id=p_job;
 RETURN n;
END $$;
CREATE FUNCTION public.worker_finish_job(p_job uuid,p_lease uuid,p_model text DEFAULT NULL,p_error text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE j portfolio_private.ingestion_jobs%ROWTYPE; n integer; actor uuid; BEGIN
 SELECT * INTO j FROM portfolio_private.ingestion_jobs WHERE id=p_job AND lease_token=p_lease AND status='processing' AND lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.documents WHERE id=j.document_id AND deleted_at IS NULL AND desired_version=j.version_id AND desired_index=j.id) THEN UPDATE portfolio_private.ingestion_jobs SET status='cancelled' WHERE id=p_job; RETURN false; END IF;
 IF p_error IS NOT NULL THEN
  UPDATE portfolio_private.ingestion_jobs SET status='failed',error=left(p_error,160),next_retry_at=CASE WHEN p_error='embedding_daily_budget_reached' THEN (date_trunc('day',now() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' ELSE now()+interval '1 minute'*power(2,attempts) END,attempts=CASE WHEN p_error='embedding_daily_budget_reached' THEN greatest(attempts-1,0) ELSE attempts END,updated_at=now() WHERE id=p_job;
  UPDATE public.documents SET ingestion_status='failed' WHERE id=j.document_id; RETURN false;
 END IF;
 SELECT count(*) INTO n FROM portfolio_private.document_chunks WHERE index_id=p_job AND embedding_model=p_model;
 IF n=0 OR n<>(SELECT count(*) FROM portfolio_private.document_chunks WHERE index_id=p_job) THEN RAISE EXCEPTION 'No valid chunks to activate' USING ERRCODE='22023'; END IF;
 UPDATE public.documents SET active_version=j.version_id,active_index=j.id,ingestion_status='completed' WHERE id=j.document_id;
 UPDATE portfolio_private.ingestion_jobs SET status='completed',embedding_model=p_model,chunk_count=n,updated_at=now() WHERE id=p_job;
 SELECT uploaded_by INTO actor FROM portfolio_private.document_versions WHERE id=j.version_id;
 INSERT INTO portfolio_private.audit_events(request_id,actor_id,entity_type,entity_id,action,request_payload,after_data) VALUES(gen_random_uuid(),actor,'documents',j.document_id,'ingested','{}',jsonb_build_object('index_id',j.id,'chunks',n)) ON CONFLICT(request_id) DO NOTHING;
 RETURN true;
END $$;
CREATE FUNCTION public.search_knowledge(p_embedding jsonb,p_model text,p_limit integer DEFAULT 6,p_project_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE q extensions.vector(1536); result jsonb; BEGIN
 q:=p_embedding::text::extensions.vector(1536);
 SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') INTO result FROM (
 SELECT c.id,d.title,c.page,c.heading,c.text_content AS excerpt,c.version_id,c.document_id,1-(c.embedding OPERATOR(extensions.<=>) q) AS score
 FROM portfolio_private.document_chunks c JOIN public.documents d ON d.id=c.document_id
 LEFT JOIN public.projects p ON p.id=d.project_id
 WHERE d.deleted_at IS NULL AND d.approved_for_chat AND c.index_id=d.active_index AND c.version_id=d.active_version AND c.embedding_model=p_model
 AND (p_project_id IS NULL OR d.project_id=p_project_id) AND (d.project_id IS NULL OR (p.status='published' AND p.deleted_at IS NULL))
 AND 1-(c.embedding OPERATOR(extensions.<=>) q)>=0.25
 ORDER BY c.embedding OPERATOR(extensions.<=>) q,c.id LIMIT least(greatest(p_limit,1),12)) t;
 RETURN result;
END $$;
CREATE FUNCTION public.public_source(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE result jsonb; BEGIN
 SELECT jsonb_build_object('id',c.id,'title',d.title,'page',c.page,'heading',c.heading,'excerpt',c.text_content,'version_id',c.version_id) INTO result
 FROM portfolio_private.document_chunks c JOIN public.documents d ON d.id=c.document_id LEFT JOIN public.projects p ON p.id=d.project_id
 WHERE c.id=p_id AND d.deleted_at IS NULL AND d.approved_for_chat AND c.index_id=d.active_index AND c.version_id=d.active_version AND (d.project_id IS NULL OR (p.status='published' AND p.deleted_at IS NULL));
 RETURN result;
END $$;
CREATE FUNCTION public.portfolio_context() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object(
 'profile',(SELECT to_jsonb(p) FROM public.profiles p WHERE status='published'),
 'projects',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT id,title,slug,summary,body_markdown,technologies,category FROM public.projects WHERE status='published' AND deleted_at IS NULL ORDER BY is_featured DESC,sort_order,id LIMIT 20)t),
 'skills',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT id,name,category,description FROM public.skills WHERE status='published' AND deleted_at IS NULL ORDER BY sort_order,id LIMIT 100)t),
 'experiences',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT id,company,job_title,started_on,ended_on,description_markdown FROM public.experiences WHERE status='published' AND deleted_at IS NULL ORDER BY started_on DESC,id LIMIT 20)t),
 'education',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT id,institution,qualification,field_of_study,started_on,ended_on,description_markdown FROM public.education WHERE status='published' AND deleted_at IS NULL ORDER BY started_on DESC,id LIMIT 20)t))
$$;
REVOKE ALL ON FUNCTION public.portfolio_context() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.portfolio_context() TO anon,authenticated,service_role;
CREATE FUNCTION public.chat_admit(p_session uuid,p_request uuid,p_ip_hash text,p_budget numeric,p_reserve numeric) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE used numeric; BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(682304,4);
 IF p_budget<=0 OR p_reserve<=0 OR p_reserve>p_budget THEN RAISE EXCEPTION 'Chat budget unavailable' USING ERRCODE='P0001'; END IF;
 UPDATE portfolio_private.chat_requests SET status='failed',cost_usd=reserved_usd,error='expired' WHERE status='running' AND lease_until<now();
 IF (SELECT count(*) FROM portfolio_private.chat_requests WHERE ip_hash=p_ip_hash AND created_at>now()-interval '1 minute')>=10 OR (SELECT count(*) FROM portfolio_private.chat_requests WHERE status='running')>=4 THEN RAISE EXCEPTION 'Rate limit exceeded' USING ERRCODE='P0001'; END IF;
 SELECT coalesce(sum(CASE WHEN status='running' THEN reserved_usd ELSE cost_usd END),0) INTO used FROM portfolio_private.chat_requests WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 IF used+p_reserve>p_budget THEN RAISE EXCEPTION 'Daily chat budget reached' USING ERRCODE='P0001'; END IF;
 INSERT INTO portfolio_private.chat_sessions(id) VALUES(p_session) ON CONFLICT DO NOTHING;
 INSERT INTO portfolio_private.chat_requests(id,session_id,ip_hash,reserved_usd) VALUES(p_request,p_session,p_ip_hash,p_reserve);
 RETURN jsonb_build_object('accepted',true);
END $$;
CREATE FUNCTION public.chat_history(p_session uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.message_order),'[]') FROM (SELECT role,content,created_at,message_order FROM portfolio_private.chat_messages WHERE session_id=p_session AND created_at>now()-interval '30 days' ORDER BY message_order DESC LIMIT 6)t
$$;
CREATE FUNCTION public.chat_finish(p_request uuid,p_question text,p_answer text,p_sources jsonb,p_prompt integer,p_output integer,p_embedding integer,p_cost numeric,p_latency integer,p_error text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE r portfolio_private.chat_requests%ROWTYPE; message uuid:=gen_random_uuid(); BEGIN
 SELECT * INTO r FROM portfolio_private.chat_requests WHERE id=p_request AND status='running' FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE portfolio_private.chat_requests SET status=CASE WHEN p_error IS NULL THEN 'completed' ELSE 'failed' END,cost_usd=CASE WHEN p_error IS NULL THEN greatest(p_cost,0) ELSE reserved_usd END,prompt_tokens=p_prompt,output_tokens=p_output,embedding_tokens=p_embedding,latency_ms=p_latency,error=left(p_error,80) WHERE id=p_request;
 IF p_error IS NULL THEN
 INSERT INTO portfolio_private.chat_messages(session_id,role,content) VALUES(r.session_id,'user',left(p_question,2000));
 INSERT INTO portfolio_private.chat_messages(id,session_id,role,content,sources) VALUES(message,r.session_id,'assistant',left(p_answer,12000),p_sources);
 ELSE RETURN NULL; END IF;
 RETURN message;
END $$;
CREATE FUNCTION public.chat_vote(p_session uuid,p_message uuid,p_vote integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF p_vote NOT IN (-1,1) OR NOT EXISTS(SELECT 1 FROM portfolio_private.chat_messages WHERE id=p_message AND session_id=p_session AND role='assistant' AND created_at>now()-interval '30 days') THEN RETURN false; END IF;
 INSERT INTO portfolio_private.chat_feedback(message_id,session_id,vote) VALUES(p_message,p_session,p_vote) ON CONFLICT(message_id) DO UPDATE SET vote=excluded.vote;
 RETURN true;
END $$;
CREATE FUNCTION public.worker_retention_cleanup() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE n integer; BEGIN
 DELETE FROM portfolio_private.chat_messages WHERE created_at<now()-interval '30 days'; GET DIAGNOSTICS n=ROW_COUNT;
 DELETE FROM portfolio_private.chat_sessions s WHERE created_at<now()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM portfolio_private.chat_messages m WHERE m.session_id=s.id);
 DELETE FROM portfolio_private.chat_requests WHERE created_at<now()-interval '90 days';
 DELETE FROM portfolio_private.evaluation_reports WHERE created_at<now()-interval '90 days';
 DELETE FROM portfolio_private.ingestion_usage WHERE created_at<now()-interval '90 days';
 DELETE FROM portfolio_private.document_chunks c WHERE NOT EXISTS(SELECT 1 FROM public.documents d WHERE d.active_index=c.index_id) AND EXISTS(SELECT 1 FROM portfolio_private.ingestion_jobs j WHERE j.id=c.index_id AND j.status IN ('completed','cancelled','failed') AND j.updated_at<now()-interval '7 days');
 RETURN n;
END $$;
CREATE FUNCTION public.admin_monitoring() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE result jsonb; BEGIN
 PERFORM portfolio_private.require_admin_id();
 SELECT jsonb_build_object('requests',count(*),'prompt_tokens',coalesce(sum(prompt_tokens),0),'output_tokens',coalesce(sum(output_tokens),0),'embedding_tokens',coalesce(sum(embedding_tokens),0),'estimated_cost_usd',coalesce(sum(cost_usd),0),'average_latency_ms',coalesce(avg(latency_ms),0),'errors',count(*) FILTER(WHERE status='failed')) INTO result FROM portfolio_private.chat_requests WHERE created_at>now()-interval '30 days';
 RETURN result||jsonb_build_object('evaluation',(SELECT to_jsonb(e) FROM portfolio_private.evaluation_reports e ORDER BY created_at DESC LIMIT 1),'average_citations',(SELECT coalesce(avg(jsonb_array_length(sources)),0) FROM portfolio_private.chat_messages WHERE role='assistant' AND created_at>now()-interval '30 days'),'ingestion_cost_usd',(SELECT coalesce(sum(cost_usd),0) FROM portfolio_private.ingestion_usage WHERE created_at>now()-interval '30 days'),'ingestion_tokens',(SELECT coalesce(sum(token_count),0) FROM portfolio_private.ingestion_usage WHERE created_at>now()-interval '30 days'),'recent_requests',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT id,status,cost_usd,prompt_tokens,output_tokens,latency_ms,error,created_at FROM portfolio_private.chat_requests ORDER BY created_at DESC LIMIT 30)t),'feedback',(SELECT jsonb_build_object('positive',count(*) FILTER(WHERE vote=1),'negative',count(*) FILTER(WHERE vote=-1)) FROM portfolio_private.chat_feedback),'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT id,document_id,status,attempts,error,chunk_count,created_at FROM portfolio_private.ingestion_jobs ORDER BY created_at DESC LIMIT 30)t));
END $$;
REVOKE ALL ON FUNCTION public.admin_monitoring() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_monitoring() TO authenticated;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('worker_claim_job','worker_store_chunks','worker_finish_job','search_knowledge','public_source','chat_admit','chat_history','chat_finish','chat_vote','worker_retention_cleanup') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;

CREATE TABLE portfolio_private.ingestion_usage (
 lease_token uuid PRIMARY KEY,job_id uuid NOT NULL,reserved_usd numeric NOT NULL,cost_usd numeric NOT NULL DEFAULT 0,
 token_count integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'running',created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portfolio_private.ingestion_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portfolio_private.ingestion_usage FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.worker_reserve_budget(p_job uuid,p_lease uuid,p_budget numeric,p_reserve numeric) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE used numeric; BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(682304,5);
 IF NOT EXISTS(SELECT 1 FROM portfolio_private.ingestion_jobs WHERE id=p_job AND lease_token=p_lease AND status='processing' AND lease_until>now()) THEN RAISE EXCEPTION 'Job lease expired' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM portfolio_private.ingestion_usage WHERE lease_token=p_lease AND job_id=p_job) THEN RETURN true; END IF;
 UPDATE portfolio_private.ingestion_usage u SET status='failed',cost_usd=reserved_usd FROM portfolio_private.ingestion_jobs j WHERE u.job_id=j.id AND u.status='running' AND (j.lease_token<>u.lease_token OR j.lease_until<now());
 SELECT coalesce(sum(CASE WHEN status='running' THEN reserved_usd ELSE cost_usd END),0) INTO used FROM portfolio_private.ingestion_usage WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 IF p_budget<=0 OR p_reserve<=0 OR used+p_reserve>p_budget THEN RETURN false; END IF;
 INSERT INTO portfolio_private.ingestion_usage(lease_token,job_id,reserved_usd) VALUES(p_lease,p_job,p_reserve);
 RETURN true;
END $$;
CREATE FUNCTION public.worker_settle_budget(p_lease uuid,p_tokens integer,p_cost numeric,p_failed boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 UPDATE portfolio_private.ingestion_usage SET status=CASE WHEN p_failed THEN 'failed' ELSE 'completed' END,token_count=greatest(p_tokens,0),cost_usd=CASE WHEN p_failed THEN reserved_usd ELSE greatest(p_cost,0) END WHERE lease_token=p_lease AND status='running';
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.worker_reserve_budget(uuid,uuid,numeric,numeric),public.worker_settle_budget(uuid,integer,numeric,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.worker_reserve_budget(uuid,uuid,numeric,numeric),public.worker_settle_budget(uuid,integer,numeric,boolean) TO service_role;

CREATE TABLE portfolio_private.evaluation_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dataset_hash text NOT NULL,case_count integer NOT NULL,
 metrics jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portfolio_private.evaluation_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portfolio_private.evaluation_reports FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.evaluation_save_report(p_dataset_hash text,p_case_count integer,p_metrics jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE result uuid; BEGIN
 IF p_dataset_hash !~ '^[a-f0-9]{64}$' OR p_case_count NOT BETWEEN 1 AND 500 OR jsonb_typeof(p_metrics)<>'object' OR length(p_metrics::text)>20000 THEN RAISE EXCEPTION 'Invalid evaluation report' USING ERRCODE='22023'; END IF;
 INSERT INTO portfolio_private.evaluation_reports(dataset_hash,case_count,metrics) VALUES(p_dataset_hash,p_case_count,p_metrics) RETURNING id INTO result;RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.evaluation_save_report(text,integer,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.evaluation_save_report(text,integer,jsonb) TO service_role;

COMMIT;
