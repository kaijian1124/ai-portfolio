// Read-only cloud smoke test. Never log keys, rows, or provider response bodies.
const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (base !== "https://nabkcsocbchmosnqyznn.supabase.co" || !key?.startsWith("sb_publishable_")) {
  console.error("Expected ai-portfolio URL and a publishable key in .env.local.");
  process.exit(1);
}
let failed = false;
const results = await Promise.all(["profiles", "skills", "projects", "experiences", "education"].map(async (table) => {
  try {
    // No status filter: check that the anonymous API itself only returns published rows.
    const url = new URL(`/rest/v1/${table}?select=id,status&limit=5`, base);
    const response = await fetch(url, { headers: { apikey: key }, cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { table, ok: false, message: `HTTP ${response.status}` };
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.some((row) => row.status !== "published")) {
      return { table, ok: false, message: "Unexpected data or non-public rows returned" };
    }
    return { table, ok: true, message: `HTTP 200; ${rows.length} visible rows in sample` };
  } catch { return { table, ok: false, message: "Network or response failure" }; }
}));
for (const { table, ok, message } of results) {
  console.log(`${ok ? "PASS" : "FAIL"} ${table}: ${message}`);
  if (!ok) failed = true;
}
console.log("Read-only sample check; local RLS tests provide seeded draft/archive coverage.");
process.exitCode = failed ? 1 : 0;
