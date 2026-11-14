BEGIN;

CREATE FUNCTION public.admin_log_page(p_feed text,p_page integer,p_size integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  skip_rows integer;
  entries jsonb;
BEGIN
  PERFORM portfolio_private.require_admin_id();
  IF p_feed IS NULL OR p_feed NOT IN ('requests','jobs','audit')
     OR p_page IS NULL OR p_page NOT BETWEEN 1 AND 2000000
     OR p_size IS NULL OR p_size NOT IN (10,20,50) THEN
    RAISE EXCEPTION 'Invalid log pagination' USING ERRCODE='22023';
  END IF;
  skip_rows := (p_page-1)*p_size;

  IF p_feed='requests' THEN
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC,t.id DESC) INTO entries FROM (
      SELECT id,created_at,status,cost_usd,latency_ms,error,rag_usage
      FROM portfolio_private.chat_requests
      ORDER BY created_at DESC,id DESC LIMIT p_size+1 OFFSET skip_rows
    ) t;
  ELSIF p_feed='jobs' THEN
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC,t.id DESC) INTO entries FROM (
      SELECT id,created_at,status,attempts,error,chunk_count
      FROM portfolio_private.ingestion_jobs
      ORDER BY created_at DESC,id DESC LIMIT p_size+1 OFFSET skip_rows
    ) t;
  ELSE
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC,t.source,t.id DESC) INTO entries FROM (
      SELECT id,created_at,entity_type,entity_id,action,source FROM (
        SELECT id,created_at,entity_type,entity_id,action,1 AS source
        FROM portfolio_private.audit_events
        UNION ALL
        SELECT id,created_at,'profiles',profile_id,action,2
        FROM portfolio_private.content_audit_logs
      ) events
      ORDER BY created_at DESC,source,id DESC LIMIT p_size+1 OFFSET skip_rows
    ) t;
  END IF;

  entries := coalesce(entries,'[]'::jsonb);
  RETURN jsonb_build_object('rows',entries-p_size,'has_next',jsonb_array_length(entries)>p_size);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_log_page(text,integer,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_log_page(text,integer,integer) TO authenticated;

COMMIT;
