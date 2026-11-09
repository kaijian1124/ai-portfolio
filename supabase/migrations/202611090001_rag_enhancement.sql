BEGIN;

ALTER TABLE portfolio_private.document_chunks
 ADD COLUMN section_ordinal integer,
 ADD COLUMN source_start integer,
 ADD COLUMN source_end integer,
 ADD COLUMN table_header text;
ALTER TABLE public.documents ADD COLUMN approved_content_sha256 text;
ALTER TABLE portfolio_private.chat_requests ADD COLUMN rag_usage jsonb NOT NULL DEFAULT '[]';
CREATE TABLE portfolio_private.rag_configuration (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
 embedding_price numeric NOT NULL DEFAULT 0.02 CHECK(embedding_price>0 AND embedding_price<=100)
);
INSERT INTO portfolio_private.rag_configuration DEFAULT VALUES;
ALTER TABLE portfolio_private.rag_configuration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portfolio_private.rag_configuration FROM PUBLIC,anon,authenticated,service_role;
UPDATE public.documents d SET approved_content_sha256=v.sha256
FROM portfolio_private.document_versions v
WHERE d.approved_for_chat AND v.id=d.active_version AND v.document_id=d.id;

UPDATE storage.buckets SET allowed_mime_types=array_append(allowed_mime_types,'text/markdown')
WHERE id='portfolio-knowledge' AND NOT ('text/markdown'=ANY(allowed_mime_types));

-- An explicit AI approval publishes exactly the completed candidate the owner reviewed.
CREATE FUNCTION portfolio_private.approve_knowledge_candidate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE candidate_sha text;
BEGIN
 IF NOT NEW.approved_for_chat THEN
  NEW.approved_content_sha256:=NULL;
  RETURN NEW;
 END IF;
 IF NEW.deleted_at IS NOT NULL THEN
  RAISE EXCEPTION 'Cannot approve a deleted document' USING ERRCODE='22023';
 END IF;
 SELECT v.sha256 INTO candidate_sha
 FROM portfolio_private.ingestion_jobs j
 JOIN portfolio_private.document_versions v ON v.id=j.version_id AND v.document_id=j.document_id
 WHERE j.id=NEW.desired_index AND j.version_id=NEW.desired_version
 AND j.document_id=NEW.id AND j.status='completed' AND j.chunk_count>0
 AND j.embedding_model=(SELECT embedding_model FROM portfolio_private.rag_configuration);
 IF NOT FOUND THEN
  -- Normal metadata edits can retain approval of the already published version.
  IF OLD.approved_for_chat AND OLD.approved_content_sha256 IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'The candidate must finish indexing before approval' USING ERRCODE='22023';
 END IF;
 NEW.active_version:=NEW.desired_version;
 NEW.active_index:=NEW.desired_index;
 NEW.approved_content_sha256:=candidate_sha;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION portfolio_private.approve_knowledge_candidate() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER approve_knowledge_candidate BEFORE UPDATE OF approved_for_chat ON public.documents
FOR EACH ROW EXECUTE FUNCTION portfolio_private.approve_knowledge_candidate();

CREATE VIEW portfolio_private.approved_chunks AS
SELECT c.*,d.title,d.project_id
FROM portfolio_private.document_chunks c
JOIN public.documents d ON d.id=c.document_id AND c.index_id=d.active_index AND c.version_id=d.active_version
JOIN portfolio_private.document_versions v ON v.id=c.version_id AND v.document_id=d.id AND v.sha256=d.approved_content_sha256
LEFT JOIN public.projects p ON p.id=d.project_id
WHERE d.deleted_at IS NULL AND d.approved_for_chat
 AND (d.project_id IS NULL OR (p.status='published' AND p.deleted_at IS NULL));
REVOKE ALL ON portfolio_private.approved_chunks FROM PUBLIC,anon,authenticated,service_role;

CREATE INDEX chunks_keyword_lookup ON portfolio_private.document_chunks
USING gin(to_tsvector('pg_catalog.simple',coalesce(heading,'')||' '||text_content));

CREATE FUNCTION public.hybrid_knowledge(p_embedding jsonb,p_model text,p_query text,
 p_project_id uuid DEFAULT NULL,p_heading text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH q AS (
  SELECT p_embedding::text::extensions.vector(1536) AS embedding,
   coalesce((SELECT string_agg(quote_literal(word),' | ') FROM unnest(
    tsvector_to_array(to_tsvector('pg_catalog.simple',left(p_query,3000)))) word
    WHERE length(word)>=3),'')::tsquery AS terms,
   lower(left(btrim(p_query),160)) AS exact
 ), scope AS (
  SELECT c.* FROM portfolio_private.approved_chunks c
  LEFT JOIN public.projects p ON p.id=p_project_id AND p.status='published' AND p.deleted_at IS NULL
  WHERE (p_heading IS NULL OR (c.project_id IS NULL AND split_part(c.heading,' / ',1)=p_heading))
  AND (p_project_id IS NULL OR c.project_id=p.id OR
   (c.project_id IS NULL AND (lower(c.heading)=lower(p.title) OR
    starts_with(lower(c.heading),lower(p.title)||' / '))))
 ), dense AS (
  SELECT c.id,row_number() OVER(ORDER BY c.embedding OPERATOR(extensions.<=>) q.embedding,c.id) AS rank
  FROM scope c CROSS JOIN q
  WHERE c.embedding_model=p_model
   AND (c.embedding OPERATOR(extensions.<=>) q.embedding)<=0.75
  ORDER BY rank LIMIT 12
 ), lexical AS (
  SELECT c.id,row_number() OVER(ORDER BY
   (length(q.exact)>=3 AND strpos(lower(c.title||' '||coalesce(c.heading,'')||' '||c.text_content),q.exact)>0) DESC,
   ts_rank(to_tsvector('pg_catalog.simple',coalesce(c.heading,'')||' '||c.text_content),q.terms) DESC,c.id) AS rank
  FROM scope c CROSS JOIN q
  WHERE (to_tsvector('pg_catalog.simple',coalesce(c.heading,'')||' '||c.text_content) @@ q.terms
    OR (length(q.exact)>=3 AND strpos(lower(c.title||' '||coalesce(c.heading,'')||' '||c.text_content),q.exact)>0))
  ORDER BY rank LIMIT 12
 ), fused AS (
  SELECT id,sum(1.0/(60+rank)) AS score FROM (SELECT * FROM dense UNION ALL SELECT * FROM lexical) candidates
  GROUP BY id ORDER BY score DESC,id LIMIT 12
 )
 SELECT CASE WHEN p_model=(SELECT embedding_model FROM portfolio_private.rag_configuration)
 THEN coalesce(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'page',c.page,'heading',c.heading,
  'excerpt',concat_ws(E'\n',c.table_header,c.text_content),'version_id',c.version_id,'project_id',c.project_id,'score',f.score)
  ORDER BY f.score DESC,c.id),'[]'::jsonb) END
 FROM fused f JOIN portfolio_private.approved_chunks c ON c.id=f.id
$$;

CREATE FUNCTION public.rag_topics() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(heading),'[]') FROM (
  SELECT DISTINCT split_part(c.heading,' / ',1) AS heading FROM portfolio_private.approved_chunks c
  WHERE project_id IS NULL AND length(split_part(c.heading,' / ',1)) BETWEEN 3 AND 160
  ORDER BY heading LIMIT 100
 ) headings
$$;

CREATE FUNCTION public.rag_index_configuration() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('model',embedding_model,'price',embedding_price)
 FROM portfolio_private.rag_configuration
$$;

-- Stage replacement indexes with the worker before calling this operator RPC.
-- Switching embedding models can reuse approval only for identical source bytes.
CREATE FUNCTION public.rag_switch_embedding(p_model text,p_price numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_model IS NULL OR length(btrim(p_model)) NOT BETWEEN 1 AND 120
 OR p_price IS NULL OR NOT (p_price>0 AND p_price<=100) THEN
  RAISE EXCEPTION 'Invalid embedding configuration' USING ERRCODE='22023';
 END IF;
 LOCK TABLE public.documents IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(
  SELECT 1 FROM public.documents d WHERE d.approved_for_chat AND d.deleted_at IS NULL
  AND NOT EXISTS(
   SELECT 1 FROM portfolio_private.ingestion_jobs j JOIN portfolio_private.document_versions v ON v.id=j.version_id
   WHERE (j.id=d.active_index OR (j.id=d.desired_index AND j.version_id=d.desired_version))
    AND j.document_id=d.id AND j.status='completed' AND j.chunk_count>0 AND j.embedding_model=p_model
    AND v.sha256=d.approved_content_sha256
  )
 ) THEN RAISE EXCEPTION 'Embedding generation incomplete' USING ERRCODE='22023'; END IF;
 UPDATE public.documents d SET active_index=j.id,active_version=j.version_id,revision=d.revision+1
 FROM portfolio_private.ingestion_jobs j JOIN portfolio_private.document_versions v ON v.id=j.version_id
 WHERE d.approved_for_chat AND d.deleted_at IS NULL
 AND j.id=d.desired_index AND j.version_id=d.desired_version AND j.document_id=d.id
 AND j.status='completed' AND j.chunk_count>0 AND j.embedding_model=p_model AND v.sha256=d.approved_content_sha256
 AND d.active_index IS DISTINCT FROM j.id;
 UPDATE portfolio_private.rag_configuration SET embedding_model=p_model,embedding_price=p_price;
END $$;

CREATE FUNCTION public.expand_knowledge(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'page',c.page,'heading',c.heading,
  'excerpt', concat_ws(E'\n',c.table_header,CASE WHEN c.ordinal>hit.ordinal AND c.source_start<hit.source_end
    THEN ltrim(substr(c.text_content,hit.source_end-c.source_start+1))
    WHEN c.ordinal<hit.ordinal AND c.source_end>hit.source_start
    THEN rtrim(left(c.text_content,greatest(0,hit.source_start-c.source_start)))
    ELSE c.text_content END),'version_id',c.version_id,'project_id',c.project_id) ORDER BY c.ordinal),'[]'::jsonb)
 FROM portfolio_private.approved_chunks hit JOIN portfolio_private.approved_chunks c
 ON c.index_id=hit.index_id AND c.section_ordinal=hit.section_ordinal
 AND c.ordinal BETWEEN hit.ordinal-1 AND hit.ordinal+1 AND c.ordinal<>hit.ordinal
 WHERE hit.id=p_id
$$;

CREATE FUNCTION public.knowledge_current(p_ids jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(p_ids) i(id)
  WHERE NOT EXISTS(SELECT 1 FROM portfolio_private.approved_chunks c WHERE c.id=i.id::uuid)
 )
$$;

CREATE FUNCTION public.rag_history(p_session uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.message_order),'[]') FROM (
  SELECT m.role,CASE WHEN m.role='user' THEN m.content END AS content,m.message_order,
   CASE WHEN m.role='assistant' THEN coalesce(
    (SELECT jsonb_agg(coalesce(s.value->>'project_id',s.value->>'topic_id',s.value->>'id') ORDER BY s.ordinality)
     FROM jsonb_array_elements(m.sources) WITH ORDINALITY s(value,ordinality)
     WHERE s.value->>'project_id' IS NOT NULL OR s.value->>'topic_id' IS NOT NULL
       OR (s.value->>'kind'='structured' AND s.value->>'id' LIKE 'projects:%')),'[]') END AS project_ids
  FROM portfolio_private.chat_messages m
  WHERE m.session_id=p_session AND m.created_at>now()-interval '30 days'
  ORDER BY m.message_order DESC LIMIT 6
 ) t
$$;

CREATE FUNCTION public.rag_record_usage(p_request uuid,p_calls jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 UPDATE portfolio_private.chat_requests SET rag_usage=p_calls
 WHERE id=p_request AND status='running' AND jsonb_typeof(p_calls)='array'
 AND length(p_calls::text)<=12000 AND jsonb_array_length(p_calls)>jsonb_array_length(rag_usage)
$$;

REVOKE ALL ON FUNCTION public.hybrid_knowledge(jsonb,text,text,uuid,text),public.expand_knowledge(uuid),
 public.knowledge_current(jsonb),public.rag_history(uuid),public.rag_record_usage(uuid,jsonb),
 public.rag_topics(),public.rag_index_configuration(),public.rag_switch_embedding(text,numeric)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hybrid_knowledge(jsonb,text,text,uuid,text),public.expand_knowledge(uuid),
 public.knowledge_current(jsonb),public.rag_history(uuid),public.rag_record_usage(uuid,jsonb),
 public.rag_topics(),public.rag_index_configuration(),public.rag_switch_embedding(text,numeric) TO service_role;


CREATE OR REPLACE FUNCTION public.admin_register_upload(p_kind text,p_title text,p_filename text,p_path text,p_sha256 text,p_size bigint,p_project_id uuid DEFAULT NULL,p_replace_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=portfolio_private.require_admin_id(); item_id uuid:=gen_random_uuid(); version_id uuid:=gen_random_uuid(); job_id uuid:=gen_random_uuid(); result jsonb; existing jsonb; old jsonb;
BEGIN
 IF p_kind NOT IN ('resume','knowledge','image') OR length(btrim(p_title)) NOT BETWEEN 1 AND 160 OR length(p_filename)>180 OR p_sha256 !~ '^[a-f0-9]{64}$' OR p_size NOT BETWEEN 1 AND 20971520
 OR p_path !~ '^[a-f0-9-]+/[a-f0-9-]+\.(pdf|docx|md|png|jpg|webp)$' THEN RAISE EXCEPTION 'Invalid upload metadata' USING ERRCODE='22023'; END IF;
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
  IF p_path !~ '\.(pdf|docx|md)$' THEN RAISE EXCEPTION 'Invalid knowledge file' USING ERRCODE='22023'; END IF;
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

CREATE OR REPLACE FUNCTION public.worker_claim_job() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE j portfolio_private.ingestion_jobs%ROWTYPE; result jsonb; BEGIN
 UPDATE portfolio_private.ingestion_jobs x SET status='cancelled' FROM public.documents d WHERE x.document_id=d.id AND x.status IN ('pending','failed','processing') AND (d.deleted_at IS NOT NULL OR d.desired_version<>x.version_id OR d.desired_index<>x.id);
 UPDATE portfolio_private.ingestion_jobs SET status='failed',error='lease_expired_after_max_attempts',updated_at=now() WHERE status='processing' AND lease_until<now() AND attempts>=3;
 UPDATE public.documents d SET ingestion_status='failed' FROM portfolio_private.ingestion_jobs expired_job WHERE expired_job.document_id=d.id AND expired_job.version_id=d.desired_version AND expired_job.id=d.desired_index AND expired_job.status='failed' AND expired_job.attempts>=3;
 SELECT * INTO j FROM portfolio_private.ingestion_jobs WHERE attempts<3 AND next_retry_at<=now() AND (status IN ('pending','failed') OR (status='processing' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE portfolio_private.ingestion_jobs SET status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',updated_at=now(),error=NULL WHERE id=j.id RETURNING * INTO j;
 UPDATE public.documents SET ingestion_status='processing' WHERE id=j.document_id AND deleted_at IS NULL AND desired_version=j.version_id AND desired_index=j.id;
 IF NOT FOUND THEN UPDATE portfolio_private.ingestion_jobs SET status='cancelled' WHERE id=j.id; RETURN NULL; END IF;
 DELETE FROM portfolio_private.document_chunks WHERE index_id=j.id;
 SELECT to_jsonb(j)||jsonb_build_object('storage_path',v.storage_path,'filename',v.filename,'sha256',v.sha256,'title',d.title) INTO result FROM portfolio_private.document_versions v JOIN public.documents d ON d.id=v.document_id WHERE v.id=j.version_id;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.worker_store_chunks(p_job uuid,p_lease uuid,p_chunks jsonb,p_model text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE j portfolio_private.ingestion_jobs%ROWTYPE; c jsonb; n integer:=0; BEGIN
 SELECT * INTO j FROM portfolio_private.ingestion_jobs WHERE id=p_job AND lease_token=p_lease AND status='processing' AND lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job lease expired' USING ERRCODE='40001'; END IF;
 IF jsonb_typeof(p_chunks)<>'array' OR jsonb_array_length(p_chunks)>64 THEN RAISE EXCEPTION 'Invalid chunk batch' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.documents WHERE id=j.document_id AND deleted_at IS NULL AND desired_version=j.version_id AND desired_index=j.id) THEN RAISE EXCEPTION 'Document withdrawn or superseded' USING ERRCODE='40001'; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p_chunks) LOOP
  IF (c->>'ordinal')::integer<0 OR jsonb_array_length(c->'embedding')<>1536 THEN RAISE EXCEPTION 'Invalid chunk' USING ERRCODE='22023'; END IF;
  INSERT INTO portfolio_private.document_chunks(document_id,version_id,index_id,ordinal,text_content,page,heading,section_ordinal,source_start,source_end,table_header,embedding,embedding_model)
  VALUES(j.document_id,j.version_id,j.id,(c->>'ordinal')::integer,c->>'text',(c->>'page')::integer,left(c->>'heading',200),(c->>'section_ordinal')::integer,(c->>'source_start')::integer,(c->>'source_end')::integer,left(c->>'table_header',400),(c->'embedding')::text::extensions.vector(1536),p_model)
  ON CONFLICT(index_id,ordinal) DO UPDATE SET text_content=excluded.text_content,page=excluded.page,heading=excluded.heading,section_ordinal=excluded.section_ordinal,source_start=excluded.source_start,source_end=excluded.source_end,table_header=excluded.table_header,embedding=excluded.embedding,embedding_model=excluded.embedding_model;
  n:=n+1;
 END LOOP;
 UPDATE portfolio_private.ingestion_jobs SET lease_until=now()+interval '10 minutes',updated_at=now() WHERE id=p_job;
 RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.worker_finish_job(p_job uuid,p_lease uuid,p_model text DEFAULT NULL,p_error text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE j portfolio_private.ingestion_jobs%ROWTYPE; n integer; actor uuid; BEGIN
 SELECT * INTO j FROM portfolio_private.ingestion_jobs WHERE id=p_job AND lease_token=p_lease AND status='processing' AND lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM public.documents WHERE id=j.document_id AND deleted_at IS NULL AND desired_version=j.version_id AND desired_index=j.id FOR UPDATE;
 IF NOT FOUND THEN UPDATE portfolio_private.ingestion_jobs SET status='cancelled' WHERE id=p_job; RETURN false; END IF;
 IF p_error IS NOT NULL THEN
  UPDATE portfolio_private.ingestion_jobs SET status='failed',error=left(p_error,160),next_retry_at=CASE WHEN p_error='embedding_daily_budget_reached' THEN (date_trunc('day',now() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' ELSE now()+interval '1 minute'*power(2,attempts) END,attempts=CASE WHEN p_error='embedding_daily_budget_reached' THEN greatest(attempts-1,0) ELSE attempts END,updated_at=now() WHERE id=p_job;
  UPDATE public.documents SET ingestion_status='failed' WHERE id=j.document_id; RETURN false;
 END IF;
 SELECT count(*) INTO n FROM portfolio_private.document_chunks WHERE index_id=p_job AND embedding_model=p_model;
 IF n=0 OR n<>(SELECT coalesce(max(ordinal)+1,0) FROM portfolio_private.document_chunks WHERE index_id=p_job) OR n<>(SELECT count(*) FROM portfolio_private.document_chunks WHERE index_id=p_job) THEN RAISE EXCEPTION 'No valid chunks to activate' USING ERRCODE='22023'; END IF;
 UPDATE public.documents SET ingestion_status='completed',revision=revision+1 WHERE id=j.document_id;
 UPDATE portfolio_private.ingestion_jobs SET status='completed',embedding_model=p_model,chunk_count=n,updated_at=now() WHERE id=p_job;
 SELECT uploaded_by INTO actor FROM portfolio_private.document_versions WHERE id=j.version_id;
 INSERT INTO portfolio_private.audit_events(request_id,actor_id,entity_type,entity_id,action,request_payload,after_data) VALUES(gen_random_uuid(),actor,'documents',j.document_id,'ingested','{}',jsonb_build_object('index_id',j.id,'chunks',n)) ON CONFLICT(request_id) DO NOTHING;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.worker_retention_cleanup() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE n integer; BEGIN
 DELETE FROM portfolio_private.chat_messages WHERE created_at<now()-interval '30 days'; GET DIAGNOSTICS n=ROW_COUNT;
 DELETE FROM portfolio_private.chat_sessions s WHERE created_at<now()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM portfolio_private.chat_messages m WHERE m.session_id=s.id);
 DELETE FROM portfolio_private.chat_requests WHERE created_at<now()-interval '90 days';
 DELETE FROM portfolio_private.evaluation_reports WHERE created_at<now()-interval '90 days';
 DELETE FROM portfolio_private.ingestion_usage WHERE created_at<now()-interval '90 days';
 DELETE FROM portfolio_private.document_chunks c WHERE NOT EXISTS(SELECT 1 FROM public.documents d WHERE d.deleted_at IS NULL AND (d.active_index=c.index_id OR d.desired_index=c.index_id)) AND EXISTS(SELECT 1 FROM portfolio_private.ingestion_jobs j WHERE j.id=c.index_id AND j.status IN ('completed','cancelled','failed') AND j.updated_at<now()-interval '7 days');
 RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.chat_admit(p_session uuid,p_request uuid,p_ip_hash text,p_budget numeric,p_reserve numeric) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE used numeric; BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(682304,4);
 IF p_budget<=0 OR p_reserve<=0 OR p_reserve>p_budget THEN RAISE EXCEPTION 'Chat budget unavailable' USING ERRCODE='P0001'; END IF;
 UPDATE portfolio_private.chat_requests SET status='failed',cost_usd=reserved_usd,error='expired' WHERE status='running' AND lease_until<now();
 IF EXISTS(SELECT 1 FROM portfolio_private.chat_requests WHERE session_id=p_session AND status='running') THEN RAISE EXCEPTION 'Session already has a pending request' USING ERRCODE='40001'; END IF;
 IF (SELECT count(*) FROM portfolio_private.chat_requests WHERE ip_hash=p_ip_hash AND created_at>now()-interval '1 minute')>=10 OR (SELECT count(*) FROM portfolio_private.chat_requests WHERE status='running')>=4 THEN RAISE EXCEPTION 'Rate limit exceeded' USING ERRCODE='P0001'; END IF;
 SELECT coalesce(sum(CASE WHEN status='running' THEN reserved_usd ELSE cost_usd END),0) INTO used FROM portfolio_private.chat_requests WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 IF used+p_reserve>p_budget THEN RAISE EXCEPTION 'Daily chat budget reached' USING ERRCODE='P0001'; END IF;
 INSERT INTO portfolio_private.chat_sessions(id) VALUES(p_session) ON CONFLICT DO NOTHING;
 INSERT INTO portfolio_private.chat_requests(id,session_id,ip_hash,reserved_usd) VALUES(p_request,p_session,p_ip_hash,p_reserve);
 RETURN jsonb_build_object('accepted',true);
END $$;

CREATE OR REPLACE FUNCTION public.search_knowledge(p_embedding jsonb,p_model text,p_limit integer DEFAULT 6,p_project_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE q extensions.vector(1536); result jsonb; BEGIN
 q:=p_embedding::text::extensions.vector(1536);
 SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') INTO result FROM (
 SELECT c.id,c.title,c.page,c.heading,c.text_content AS excerpt,c.version_id,c.document_id,1-(c.embedding OPERATOR(extensions.<=>) q) AS score
 FROM portfolio_private.approved_chunks c
 WHERE c.embedding_model=p_model AND (p_project_id IS NULL OR c.project_id=p_project_id)
 AND 1-(c.embedding OPERATOR(extensions.<=>) q)>=0.25
 ORDER BY c.embedding OPERATOR(extensions.<=>) q,c.id LIMIT least(greatest(p_limit,1),12)) t;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.public_source(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE result jsonb; BEGIN
 SELECT jsonb_build_object('id',c.id,'title',c.title,'page',c.page,'heading',c.heading,
  'excerpt',concat_ws(E'\n',c.table_header,c.text_content),'version_id',c.version_id) INTO result
 FROM portfolio_private.approved_chunks c WHERE c.id=p_id;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.admin_monitoring() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE result jsonb; BEGIN
 PERFORM portfolio_private.require_admin_id();
 SELECT jsonb_build_object('requests',count(*),'prompt_tokens',coalesce(sum(prompt_tokens),0),'output_tokens',coalesce(sum(output_tokens),0),'embedding_tokens',coalesce(sum(embedding_tokens),0),'estimated_cost_usd',coalesce(sum(cost_usd),0),'average_latency_ms',coalesce(avg(latency_ms),0),'errors',count(*) FILTER(WHERE status='failed')) INTO result FROM portfolio_private.chat_requests WHERE created_at>now()-interval '30 days';
 RETURN result||jsonb_build_object('evaluation',(SELECT to_jsonb(e) FROM portfolio_private.evaluation_reports e ORDER BY created_at DESC LIMIT 1),'average_citations',(SELECT coalesce(avg(jsonb_array_length(sources)),0) FROM portfolio_private.chat_messages WHERE role='assistant' AND created_at>now()-interval '30 days'),'ingestion_cost_usd',(SELECT coalesce(sum(cost_usd),0) FROM portfolio_private.ingestion_usage WHERE created_at>now()-interval '30 days'),'chat_cached_input_tokens',(SELECT coalesce(sum((c.value->>'cached_input_tokens')::bigint),0) FROM portfolio_private.chat_requests r CROSS JOIN LATERAL jsonb_array_elements(r.rag_usage) c(value) WHERE r.created_at>now()-interval '30 days'),'usage_unreported',(SELECT count(*) FROM portfolio_private.chat_requests WHERE status='failed' AND rag_usage='[]' AND created_at>now()-interval '30 days'),'ingestion_tokens',(SELECT coalesce(sum(token_count),0) FROM portfolio_private.ingestion_usage WHERE created_at>now()-interval '30 days'),'recent_requests',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT id,status,cost_usd,rag_usage,prompt_tokens,output_tokens,latency_ms,error,created_at FROM portfolio_private.chat_requests ORDER BY created_at DESC LIMIT 30)t),'feedback',(SELECT jsonb_build_object('positive',count(*) FILTER(WHERE vote=1),'negative',count(*) FILTER(WHERE vote=-1)) FROM portfolio_private.chat_feedback),'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT id,document_id,status,attempts,error,chunk_count,created_at FROM portfolio_private.ingestion_jobs ORDER BY created_at DESC LIMIT 30)t));
END $$;

COMMIT;
