-- Read-only verification after applying 202611060001_public_content.sql.
-- The first result must contain exactly five rows, each with RLS=true.
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('profiles', 'skills', 'projects', 'experiences', 'education')
ORDER BY c.relname;

-- The second result must contain a SELECT-only published_content_read policy per table.
SELECT tablename, policyname, roles, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('profiles', 'skills', 'projects', 'experiences', 'education')
ORDER BY tablename;

-- The last result must be true, false, false, false, false for each browser role/table.
SELECT r.role_name, t.table_name,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'SELECT') AS can_select,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'INSERT') AS can_insert,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'UPDATE') AS can_update,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'DELETE') AS can_delete,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'TRUNCATE') AS can_truncate
FROM (VALUES ('anon'), ('authenticated')) AS r(role_name)
CROSS JOIN (VALUES ('profiles'), ('skills'), ('projects'), ('experiences'), ('education')) AS t(table_name)
ORDER BY r.role_name, t.table_name;
