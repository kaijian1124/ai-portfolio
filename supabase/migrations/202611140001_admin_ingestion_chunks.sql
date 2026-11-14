CREATE FUNCTION public.admin_ingestion_chunks(
  p_document uuid,
  p_version uuid,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  document_title text;
  version_filename text;
  active_index_id uuid;
  inspected_index_id uuid;
  total_chunks integer;
  chunk_rows jsonb;
BEGIN
  PERFORM portfolio_private.require_admin_id();
  IF p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 100000
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Invalid pagination' USING ERRCODE = '22023';
  END IF;

  SELECT d.title, v.filename, d.active_index
  INTO document_title, version_filename, active_index_id
  FROM public.documents d
  JOIN portfolio_private.document_versions v ON v.document_id = d.id
  WHERE d.id = p_document AND v.id = p_version AND d.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document version not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT j.id INTO inspected_index_id
  FROM portfolio_private.ingestion_jobs j
  WHERE j.document_id = p_document AND j.version_id = p_version
    AND j.status = 'completed'
    AND EXISTS (
      SELECT 1 FROM portfolio_private.document_chunks c WHERE c.index_id = j.id
    )
  ORDER BY (j.id IS NOT DISTINCT FROM active_index_id) DESC, j.updated_at DESC, j.id DESC
  LIMIT 1;

  SELECT count(*) INTO total_chunks
  FROM portfolio_private.document_chunks c
  WHERE c.index_id = inspected_index_id
    AND c.document_id = p_document AND c.version_id = p_version;

  SELECT coalesce(jsonb_agg(to_jsonb(rows) ORDER BY rows.ordinal), '[]'::jsonb)
  INTO chunk_rows
  FROM (
    SELECT c.ordinal, c.page, c.heading, c.table_header, c.text_content
    FROM portfolio_private.document_chunks c
    WHERE c.index_id = inspected_index_id
      AND c.document_id = p_document AND c.version_id = p_version
    ORDER BY c.ordinal
    LIMIT p_limit OFFSET p_offset
  ) rows;

  RETURN jsonb_build_object(
    'title', document_title, 'filename', version_filename,
    'index_id', inspected_index_id,
    'is_active', coalesce(inspected_index_id = active_index_id, false),
    'total', total_chunks, 'chunks', chunk_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_ingestion_chunks(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_ingestion_chunks(uuid, uuid, integer, integer)
  TO authenticated;
