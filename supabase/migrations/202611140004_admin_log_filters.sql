BEGIN;

CREATE FUNCTION public.admin_log_page(p_feed text,p_page integer,p_size integer,p_filter text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  skip_rows integer;
  entries jsonb;
  actions jsonb;
BEGIN
  PERFORM portfolio_private.require_admin_id();
  IF p_feed IS NULL OR p_feed NOT IN ('requests','audit')
     OR p_page IS NULL OR p_page NOT BETWEEN 1 AND 2000000
     OR p_size IS NULL OR p_size NOT IN (10,20,50)
     OR (p_filter IS NOT NULL AND length(p_filter) NOT BETWEEN 1 AND 160)
     OR (p_feed='requests' AND p_filter NOT IN ('running','completed','failed')) THEN
    RAISE EXCEPTION 'Invalid log pagination' USING ERRCODE='22023';
  END IF;
  skip_rows := (p_page-1)*p_size;

  IF p_feed='requests' THEN
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC,t.id DESC) INTO entries FROM (
      SELECT id,created_at,status,cost_usd,latency_ms,error,rag_usage
      FROM portfolio_private.chat_requests
      WHERE p_filter IS NULL OR status=p_filter
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
      WHERE p_filter IS NULL OR action=p_filter
      ORDER BY created_at DESC,source,id DESC LIMIT p_size+1 OFFSET skip_rows
    ) t;
    SELECT jsonb_agg(action ORDER BY action) INTO actions FROM (
      SELECT action FROM portfolio_private.audit_events
      UNION
      SELECT action FROM portfolio_private.content_audit_logs
    ) recorded_actions;
  END IF;

  entries := coalesce(entries,'[]'::jsonb);
  RETURN jsonb_build_object('rows',entries-p_size,'has_next',jsonb_array_length(entries)>p_size,
    'actions',coalesce(actions,'[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_log_page(text,integer,integer,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_log_page(text,integer,integer,text) TO authenticated;

COMMIT;
