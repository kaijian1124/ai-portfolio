import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const tables = ["profiles", "skills", "projects", "experiences", "education"];
const db = new PGlite();

before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;`);
  await db.exec(await readFile(new URL("../migrations/202611060001_public_content.sql", import.meta.url), "utf8"));
  await db.exec(`
    INSERT INTO public.profiles (display_name, status) VALUES ('TEST ONLY', 'published');
    INSERT INTO public.skills (name, status) VALUES ('TEST public', 'published'), ('TEST draft', 'draft'), ('TEST archived', 'archived');
    INSERT INTO public.projects (title, slug, status) VALUES ('TEST public', 'test-public', 'published'), ('TEST draft', 'test-draft', 'draft'), ('TEST archived', 'test-archived', 'archived');
    INSERT INTO public.experiences (company, job_title, started_on, status) VALUES ('TEST public', 'TEST role', '2024-01-01', 'published'), ('TEST draft', 'TEST role', '2024-01-01', 'draft'), ('TEST archived', 'TEST role', '2024-01-01', 'archived');
    INSERT INTO public.education (institution, qualification, started_on, status) VALUES ('TEST public', 'TEST degree', '2020-01-01', 'published'), ('TEST draft', 'TEST degree', '2020-01-01', 'draft'), ('TEST archived', 'TEST degree', '2020-01-01', 'archived');
  `);
});
after(async () => { await db.close(); });

async function asRole(role, action) {
  await db.exec(`BEGIN; SET LOCAL ROLE ${role};`);
  try { return await action(); }
  finally { await db.exec("ROLLBACK;"); }
}

for (const role of ["anon", "authenticated"]) {
  for (const table of tables) {
    test(`${role} can only read published ${table}`, async () => {
      await asRole(role, async () => {
        const { rows } = await db.query(`SELECT status FROM public.${table}`);
        assert.deepEqual(rows, [{ status: "published" }]);
      });
    });
  }
  test(`${role} cannot modify content or truncate tables`, async () => {
    for (const table of tables) {
      for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        const { rows } = await db.query("SELECT has_table_privilege($1, $2, $3) AS allowed", [role, `public.${table}`, privilege]);
        assert.equal(rows[0].allowed, false);
      }
    }
    await assert.rejects(asRole(role, () => db.exec("DELETE FROM public.projects")), /permission denied/);
    await assert.rejects(asRole(role, () => db.exec("INSERT INTO public.skills (name) VALUES ('unauthorized')")), /permission denied/);
  });
}

test("unpublishing a profile immediately hides it", async () => {
  await db.exec("BEGIN; UPDATE public.profiles SET status = 'draft'; SET LOCAL ROLE anon;");
  try { assert.equal((await db.query("SELECT * FROM public.profiles")).rows.length, 0); }
  finally { await db.exec("ROLLBACK;"); }
});

test("all content tables have RLS enabled", async () => {
  const { rows } = await db.query("SELECT relname, relrowsecurity FROM pg_class WHERE oid = ANY($1::regclass[])", [tables.map((name) => `public.${name}`)]);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.relrowsecurity));
});

test("new content starts as a draft", async () => {
  await db.exec("BEGIN;");
  try {
    const { rows } = await db.query("INSERT INTO public.projects (title, slug) VALUES ('TEST default', 'test-default') RETURNING status");
    assert.equal(rows[0].status, "draft");
  } finally { await db.exec("ROLLBACK;"); }
});

test("database enforces singleton profile, unique slugs, status and date bounds", async () => {
  for (const sql of [
    "INSERT INTO public.profiles (display_name) VALUES ('TEST duplicate')",
    "INSERT INTO public.projects (title, slug) VALUES ('TEST duplicate', 'test-public')",
    "INSERT INTO public.skills (name, status) VALUES ('TEST invalid', 'unknown')",
    "INSERT INTO public.projects (title, slug) VALUES ('TEST invalid', 'Invalid Slug')",
    "INSERT INTO public.experiences (company, job_title, started_on, ended_on) VALUES ('TEST', 'TEST', '2025-01-01', '2024-01-01')",
    "INSERT INTO public.education (institution, qualification, started_on, ended_on) VALUES ('TEST', 'TEST', '2025-01-01', '2024-01-01')",
  ]) {
    await db.exec("BEGIN;");
    try { await assert.rejects(db.exec(sql), /constraint/); }
    finally { await db.exec("ROLLBACK;"); }
  }
});

test("updated_at is maintained by database on change", async () => {
  await db.exec("BEGIN;");
  try {
    await db.exec("UPDATE public.skills SET updated_at = '2000-01-01' WHERE status = 'draft'");
    const { rows } = await db.query("SELECT updated_at > '2020-01-01'::timestamptz AS refreshed FROM public.skills WHERE status = 'draft'");
    assert.equal(rows[0].refreshed, true);
  } finally { await db.exec("ROLLBACK;"); }
});
