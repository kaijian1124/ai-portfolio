CREATE FUNCTION public.hybrid_knowledge(p_embedding jsonb,p_model text,p_query text,
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
  'excerpt',concat_ws(E'\n',c.table_header,c.text_content),'version_id',c.version_id,'project_id',c.project_id,'score',f.score)
  ORDER BY f.score DESC,c.id),'[]'::jsonb) END AS hits
 FROM fused f JOIN portfolio_private.approved_chunks c ON c.id=f.id
 )
 SELECT CASE WHEN ranked.hits IS NULL OR NOT p_trace THEN ranked.hits ELSE
 jsonb_build_object('fused',ranked.hits,'vector',(SELECT coalesce(jsonb_agg(to_jsonb(dense) ORDER BY rank),'[]') FROM dense),
 'keyword',(SELECT coalesce(jsonb_agg(to_jsonb(lexical) ORDER BY rank),'[]') FROM lexical)) END
 FROM ranked
$$;

CREATE OR REPLACE FUNCTION public.worker_retention_cleanup() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE n integer; BEGIN
 DELETE FROM portfolio_private.chat_messages WHERE created_at<now()-interval '30 days'; GET DIAGNOSTICS n=ROW_COUNT;
 DELETE FROM portfolio_private.chat_sessions s WHERE created_at<now()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM portfolio_private.chat_messages m WHERE m.session_id=s.id);
 DELETE FROM portfolio_private.retrieval_traces t USING portfolio_private.chat_requests r
 WHERE t.request_id=r.id AND r.created_at<now()-interval '30 days';
 DELETE FROM portfolio_private.chat_requests WHERE created_at<now()-interval '90 days';
 DELETE FROM portfolio_private.evaluation_reports WHERE created_at<now()-interval '90 days';
 DELETE FROM portfolio_private.ingestion_usage WHERE created_at<now()-interval '90 days';
 DELETE FROM portfolio_private.document_chunks c WHERE NOT EXISTS(SELECT 1 FROM public.documents d WHERE d.deleted_at IS NULL AND (d.active_index=c.index_id OR d.desired_index=c.index_id)) AND EXISTS(SELECT 1 FROM portfolio_private.ingestion_jobs j WHERE j.id=c.index_id AND j.status IN ('completed','cancelled','failed') AND j.updated_at<now()-interval '7 days');
 RETURN n;
END $$;


CREATE TABLE portfolio_private.retrieval_traces (
  request_id uuid PRIMARY KEY REFERENCES portfolio_private.chat_requests(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  trace jsonb NOT NULL CHECK (jsonb_typeof(trace) = 'object' AND pg_column_size(trace) <= 131072)
);
ALTER TABLE portfolio_private.retrieval_traces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portfolio_private.retrieval_traces FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.rag_record_trace(p_request uuid,p_question text,p_trace jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO portfolio_private.retrieval_traces(request_id,question,trace)
  SELECT id,p_question,p_trace FROM portfolio_private.chat_requests
  WHERE id=p_request AND created_at>now()-interval '30 days'
  ON CONFLICT (request_id) DO NOTHING
$$;

CREATE FUNCTION public.admin_retrieval_runs()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM portfolio_private.require_admin_id();
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY created_at DESC,id DESC) FROM (
    SELECT r.id,r.created_at,r.status,r.latency_ms,r.cost_usd,t.question,t.request_id IS NOT NULL AS traced
    FROM portfolio_private.chat_requests r
    LEFT JOIN portfolio_private.retrieval_traces t ON t.request_id=r.id
    WHERE r.created_at>now()-interval '30 days'
    ORDER BY r.created_at DESC,r.id DESC LIMIT 50
  ) r),'[]'::jsonb);
END;
$$;

CREATE FUNCTION public.admin_retrieval_trace(p_request uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM portfolio_private.require_admin_id();
  RETURN (SELECT jsonb_build_object('question',t.question,'trace',t.trace,
      'answer',(SELECT m.content FROM portfolio_private.chat_messages m
                WHERE m.id::text=t.trace->>'message_id' AND m.session_id=r.session_id
                  AND m.role='assistant' AND m.created_at>now()-interval '30 days'))
    FROM portfolio_private.retrieval_traces t JOIN portfolio_private.chat_requests r ON r.id=t.request_id
    WHERE r.id=p_request AND r.created_at>now()-interval '30 days');
END;
$$;

CREATE FUNCTION public.admin_retrieval_chunk(p_chunk uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM portfolio_private.require_admin_id();
  RETURN (SELECT jsonb_build_object('id',c.id,'title',d.title,'document_id',c.document_id,
      'version_id',c.version_id,'index_id',c.index_id,'ordinal',c.ordinal,'page',c.page,
      'heading',c.heading,'table_header',c.table_header,'text',c.text_content)
    FROM portfolio_private.document_chunks c JOIN public.documents d ON d.id=c.document_id
    WHERE c.id=p_chunk AND d.deleted_at IS NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.rag_record_trace(uuid,text,jsonb),
  public.hybrid_knowledge(jsonb,text,text,uuid,text,boolean),
  public.admin_retrieval_runs(),public.admin_retrieval_trace(uuid),public.admin_retrieval_chunk(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.rag_record_trace(uuid,text,jsonb),
  public.hybrid_knowledge(jsonb,text,text,uuid,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_retrieval_runs(),public.admin_retrieval_trace(uuid),
  public.admin_retrieval_chunk(uuid) TO authenticated;
