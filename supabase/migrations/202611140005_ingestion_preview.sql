BEGIN;

ALTER TABLE portfolio_private.ingestion_jobs
  ADD COLUMN preview_chunks jsonb,
  ADD COLUMN preview_hash text,
  ADD COLUMN preview_metadata jsonb,
  ADD COLUMN preview_approved_at timestamptz;

CREATE OR REPLACE FUNCTION portfolio_private.claim_ingestion(p_preview boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE j portfolio_private.ingestion_jobs%ROWTYPE; result jsonb; BEGIN
 UPDATE portfolio_private.ingestion_jobs x SET status='cancelled' FROM public.documents d WHERE x.document_id=d.id AND x.status IN ('pending','failed','processing') AND (d.deleted_at IS NOT NULL OR d.desired_version<>x.version_id OR d.desired_index<>x.id);
 UPDATE portfolio_private.ingestion_jobs SET status='failed',error='lease_expired_after_max_attempts',updated_at=now() WHERE status='processing' AND lease_until<now() AND attempts>=3;
 UPDATE public.documents d SET ingestion_status='failed' FROM portfolio_private.ingestion_jobs expired_job WHERE expired_job.document_id=d.id AND expired_job.version_id=d.desired_version AND expired_job.id=d.desired_index AND expired_job.status='failed' AND expired_job.attempts>=3;
 SELECT * INTO j FROM portfolio_private.ingestion_jobs WHERE attempts<3
 AND EXISTS (
   SELECT 1 FROM public.documents d WHERE d.id=ingestion_jobs.document_id
   AND d.deleted_at IS NULL AND d.desired_index=ingestion_jobs.id
 )
 AND CASE WHEN p_preview THEN preview_chunks IS NULL
 ELSE preview_chunks IS NOT NULL AND preview_approved_at IS NOT NULL END
 AND next_retry_at<=now() AND (status IN ('pending','failed') OR (status='processing' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE portfolio_private.ingestion_jobs SET status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',updated_at=now(),error=NULL WHERE id=j.id RETURNING * INTO j;
 UPDATE public.documents SET ingestion_status='processing' WHERE id=j.document_id AND deleted_at IS NULL AND desired_version=j.version_id AND desired_index=j.id;
 IF NOT FOUND THEN UPDATE portfolio_private.ingestion_jobs SET status='cancelled' WHERE id=j.id; RETURN NULL; END IF;
 DELETE FROM portfolio_private.document_chunks WHERE index_id=j.id;
 SELECT (to_jsonb(j) - 'preview_chunks')||jsonb_build_object('storage_path',v.storage_path,'filename',v.filename,'sha256',v.sha256,'title',d.title) INTO result FROM portfolio_private.document_versions v JOIN public.documents d ON d.id=v.document_id WHERE v.id=j.version_id;
 RETURN result;
END $$;

-- Legacy workers stop taking jobs until they are upgraded to the two-phase protocol.
CREATE OR REPLACE FUNCTION public.worker_claim_job() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT NULL::jsonb $$;

CREATE FUNCTION public.worker_claim_preview_job() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT portfolio_private.claim_ingestion(true)
$$;

CREATE FUNCTION public.worker_claim_embedding_job() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT portfolio_private.claim_ingestion(false)
$$;

CREATE FUNCTION public.worker_save_preview(p_job uuid,p_lease uuid,p_chunks jsonb,p_metadata jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j portfolio_private.ingestion_jobs%ROWTYPE;
BEGIN
 SELECT * INTO j FROM portfolio_private.ingestion_jobs
 WHERE id=p_job AND status='processing' AND lease_token=p_lease AND lease_until>now()
   AND preview_chunks IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM public.documents WHERE id=j.document_id AND deleted_at IS NULL
   AND desired_version=j.version_id AND desired_index=j.id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF jsonb_typeof(p_chunks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_chunks) NOT BETWEEN 1 AND 500
   OR length(p_chunks::text)>2500000 OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object'
   OR length(p_metadata::text)>4000 THEN
   RAISE EXCEPTION 'Invalid preview' USING ERRCODE='22023';
 END IF;
 UPDATE portfolio_private.ingestion_jobs SET preview_chunks=p_chunks,
   preview_hash=encode(sha256(convert_to(p_chunks::text,'UTF8')),'hex'),
   preview_metadata=p_metadata,status='pending',attempts=0,lease_token=NULL,lease_until=NULL,
   chunk_count=jsonb_array_length(p_chunks),updated_at=now()
 WHERE id=p_job;
 UPDATE public.documents SET ingestion_status='pending' WHERE id=j.document_id;
 RETURN true;
END $$;

CREATE FUNCTION public.worker_load_approved_preview(p_job uuid,p_lease uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT j.preview_chunks FROM portfolio_private.ingestion_jobs j JOIN public.documents d
 ON d.id=j.document_id AND d.desired_version=j.version_id AND d.desired_index=j.id
 WHERE j.id=p_job AND j.lease_token=p_lease AND j.lease_until>now() AND j.status='processing'
 AND j.preview_approved_at IS NOT NULL AND d.deleted_at IS NULL
$$;

CREATE FUNCTION public.worker_preview_current(p_job uuid,p_lease uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS (SELECT 1 FROM portfolio_private.ingestion_jobs j JOIN public.documents d
 ON d.id=j.document_id AND d.desired_version=j.version_id AND d.desired_index=j.id
 WHERE j.id=p_job AND j.lease_token=p_lease AND j.lease_until>now() AND j.status='processing'
 AND j.preview_approved_at IS NOT NULL AND j.preview_chunks IS NOT NULL AND d.deleted_at IS NULL)
$$;

CREATE FUNCTION public.admin_ingestion_preview(p_document uuid,p_version uuid,
 p_offset integer DEFAULT 0,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE j portfolio_private.ingestion_jobs%ROWTYPE;
BEGIN
 PERFORM portfolio_private.require_admin_id();
 IF p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 100000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
   RAISE EXCEPTION 'Invalid pagination' USING ERRCODE='22023';
 END IF;
 SELECT x.* INTO j FROM portfolio_private.ingestion_jobs x JOIN public.documents d
 ON d.id=x.document_id AND d.desired_index=x.id AND d.desired_version=x.version_id
 WHERE d.id=p_document AND x.version_id=p_version AND d.deleted_at IS NULL
 AND x.preview_chunks IS NOT NULL AND x.status<>'completed';
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('job_id',j.id,'hash',j.preview_hash,'approved_at',j.preview_approved_at,
 'total',jsonb_array_length(j.preview_chunks),'metadata',j.preview_metadata,
 'chunks',(SELECT coalesce(jsonb_agg(value ORDER BY n),'[]'::jsonb)
 FROM (SELECT value,n FROM jsonb_array_elements(j.preview_chunks) WITH ORDINALITY a(value,n)
 ORDER BY n OFFSET p_offset LIMIT p_limit) page));
END $$;

CREATE FUNCTION public.admin_approve_ingestion_preview(p_document uuid,p_job uuid,p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=portfolio_private.require_admin_id(); j portfolio_private.ingestion_jobs%ROWTYPE;
BEGIN
 SELECT * INTO j FROM portfolio_private.ingestion_jobs WHERE id=p_job AND document_id=p_document FOR UPDATE;
 IF NOT FOUND OR j.preview_hash IS NULL OR j.preview_hash IS DISTINCT FROM p_hash
    OR NOT EXISTS(SELECT 1 FROM public.documents WHERE id=p_document AND deleted_at IS NULL
      AND desired_version=j.version_id AND desired_index=j.id FOR UPDATE) THEN
   RAISE EXCEPTION 'Preview changed. Reload to review it again.' USING ERRCODE='40001';
 END IF;
 IF j.preview_approved_at IS NULL THEN
   UPDATE portfolio_private.ingestion_jobs SET preview_approved_at=now(),updated_at=now() WHERE id=p_job;
   INSERT INTO portfolio_private.audit_events(request_id,actor_id,entity_type,entity_id,action,request_payload,after_data)
   VALUES(gen_random_uuid(),actor,'documents',p_document,'approve_embedding',
     jsonb_build_object('job_id',p_job,'preview_hash',p_hash),
     jsonb_build_object('version_id',j.version_id,'chunks',j.chunk_count));
 END IF;
 RETURN jsonb_build_object('job_id',p_job,'approved',true);
END $$;

CREATE OR REPLACE FUNCTION public.admin_document_versions(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM portfolio_private.require_admin_id();
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC,t.id DESC) FROM (
  SELECT v.id,v.filename,v.created_at,v.file_size,
  (SELECT jsonb_build_object('status',CASE
    WHEN j.status='pending' AND j.preview_chunks IS NOT NULL AND j.preview_approved_at IS NULL
      THEN 'awaiting review'
    WHEN j.status='pending' AND j.preview_approved_at IS NOT NULL THEN 'embedding queued'
    ELSE j.status END,'attempts',j.attempts,'error',j.error,'chunk_count',j.chunk_count)
    FROM portfolio_private.ingestion_jobs j WHERE j.version_id=v.id
    ORDER BY j.created_at DESC,j.id DESC LIMIT 1) AS processing
  FROM portfolio_private.document_versions v WHERE v.document_id=p_id
 ) t),'[]'::jsonb);
END $$;

CREATE FUNCTION public.admin_ingestion_provenance(p_index uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM portfolio_private.require_admin_id();
 RETURN (SELECT jsonb_build_object('metadata',j.preview_metadata,'approved_at',j.preview_approved_at,
    'chunks',j.chunk_count,'model',j.embedding_model,'status',j.status,'hash',j.preview_hash)
    FROM portfolio_private.ingestion_jobs j JOIN public.documents d ON d.id=j.document_id
    WHERE j.id=p_index AND d.deleted_at IS NULL AND j.status='completed');
END $$;

-- Each saved vector must still refer to the reviewed text and location.
CREATE FUNCTION portfolio_private.require_approved_chunk() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE approved jsonb;
BEGIN
 SELECT j.preview_chunks->NEW.ordinal INTO approved FROM portfolio_private.ingestion_jobs j
 WHERE j.id=NEW.index_id AND j.preview_approved_at IS NOT NULL;
 IF approved IS NULL OR NEW.text_content IS DISTINCT FROM approved->>'text'
    OR NEW.page IS DISTINCT FROM (approved->>'page')::integer
    OR NEW.heading IS DISTINCT FROM approved->>'heading'
    OR NEW.table_header IS DISTINCT FROM approved->>'table_header'
    OR NEW.section_ordinal IS DISTINCT FROM (approved->>'section_ordinal')::integer
    OR NEW.source_start IS DISTINCT FROM (approved->>'source_start')::integer
    OR NEW.source_end IS DISTINCT FROM (approved->>'source_end')::integer THEN
   RAISE EXCEPTION 'Chunk differs from approved preview' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER require_approved_chunk BEFORE INSERT OR UPDATE ON portfolio_private.document_chunks
FOR EACH ROW EXECUTE FUNCTION portfolio_private.require_approved_chunk();

CREATE FUNCTION portfolio_private.check_preview_completion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed'
 AND (NEW.preview_approved_at IS NULL OR NEW.chunk_count IS DISTINCT FROM jsonb_array_length(NEW.preview_chunks)) THEN
   RAISE EXCEPTION 'Approved preview is incomplete' USING ERRCODE='40001';
 END IF;
 IF NEW.status='completed' OR NEW.status='cancelled' THEN
   NEW.preview_chunks:=NULL;
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER check_preview_completion BEFORE UPDATE OF status ON portfolio_private.ingestion_jobs
FOR EACH ROW EXECUTE FUNCTION portfolio_private.check_preview_completion();

REVOKE ALL ON FUNCTION portfolio_private.claim_ingestion(boolean),
 portfolio_private.require_approved_chunk(),portfolio_private.check_preview_completion(),
 public.worker_claim_preview_job(),public.worker_claim_embedding_job(),
 public.worker_save_preview(uuid,uuid,jsonb,jsonb),public.worker_load_approved_preview(uuid,uuid),
 public.worker_preview_current(uuid,uuid),
 public.admin_ingestion_preview(uuid,uuid,integer,integer),
 public.admin_approve_ingestion_preview(uuid,uuid,text),public.admin_ingestion_provenance(uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.worker_claim_preview_job(),public.worker_claim_embedding_job(),
 public.worker_save_preview(uuid,uuid,jsonb,jsonb),public.worker_load_approved_preview(uuid,uuid),
 public.worker_preview_current(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_ingestion_preview(uuid,uuid,integer,integer),
 public.admin_approve_ingestion_preview(uuid,uuid,text),public.admin_ingestion_provenance(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.hybrid_knowledge(p_embedding jsonb,p_model text,p_query text,
 p_project_id uuid,p_heading text,p_trace boolean)
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
 ), ranked AS (
 SELECT CASE WHEN p_model=(SELECT embedding_model FROM portfolio_private.rag_configuration)
 THEN coalesce(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'page',c.page,'heading',c.heading,
  'excerpt',concat_ws(E'\n',c.table_header,c.text_content),'version_id',c.version_id,'index_id',c.index_id,'project_id',c.project_id,'score',f.score)
  ORDER BY f.score DESC,c.id),'[]'::jsonb) END AS hits
 FROM fused f JOIN portfolio_private.approved_chunks c ON c.id=f.id
 )
 SELECT CASE WHEN ranked.hits IS NULL OR NOT p_trace THEN ranked.hits ELSE
 jsonb_build_object('fused',ranked.hits,'vector',(SELECT coalesce(jsonb_agg(to_jsonb(dense) ORDER BY rank),'[]') FROM dense),
 'keyword',(SELECT coalesce(jsonb_agg(to_jsonb(lexical) ORDER BY rank),'[]') FROM lexical)) END
 FROM ranked
$$;

COMMIT;
