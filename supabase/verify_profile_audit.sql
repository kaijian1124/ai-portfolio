-- Run in the Supabase SQL Editor as project owner. This is read-only.
-- Do not expose the private schema or grant browser roles access to it.
SELECT id, created_at, actor_id, action,
       before_data->>'status' AS previous_status,
       after_data->>'status' AS saved_status,
       (after_data->>'revision')::bigint AS saved_revision
FROM portfolio_private.content_audit_logs
ORDER BY created_at DESC, id DESC
LIMIT 20;
