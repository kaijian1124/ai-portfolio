BEGIN;
ALTER TABLE portfolio_private.chat_messages ADD COLUMN project_memory jsonb;

CREATE INDEX chat_project_memory_latest ON portfolio_private.chat_messages(session_id,message_order DESC)
WHERE project_memory IS NOT NULL;

CREATE FUNCTION public.rag_project_memory(p_session uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT project_memory FROM portfolio_private.chat_messages
 WHERE session_id=p_session AND role='assistant' AND project_memory IS NOT NULL
   AND created_at>now()-interval '30 days'
 ORDER BY message_order DESC LIMIT 1
$$;

CREATE FUNCTION public.chat_finish_with_memory(p_request uuid,p_question text,p_answer text,
 p_sources jsonb,p_prompt integer,p_output integer,p_embedding integer,p_cost numeric,
 p_latency integer,p_memory jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE message uuid;
BEGIN
 IF p_memory IS NOT NULL AND (jsonb_typeof(p_memory) IS DISTINCT FROM 'object'
   OR length(p_memory::text)>6000) THEN
    RAISE EXCEPTION 'Invalid conversation state' USING ERRCODE='22023';
 END IF;
 message:=public.chat_finish(p_request,p_question,p_answer,p_sources,p_prompt,p_output,
  p_embedding,p_cost,p_latency);
 IF message IS NOT NULL AND p_memory IS NOT NULL THEN
  UPDATE portfolio_private.chat_messages SET project_memory=p_memory WHERE id=message;
 END IF;
 RETURN message;
END $$;
REVOKE ALL ON FUNCTION public.rag_project_memory(uuid),
 public.chat_finish_with_memory(uuid,text,text,jsonb,integer,integer,integer,numeric,integer,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.rag_project_memory(uuid),
 public.chat_finish_with_memory(uuid,text,text,jsonb,integer,integer,integer,numeric,integer,jsonb)
 TO service_role;

COMMIT;
