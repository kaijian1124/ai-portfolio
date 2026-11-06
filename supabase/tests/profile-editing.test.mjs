import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const ADMIN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const payload = {
  display_name: "TEST ONLY", headline: "Test headline", about_markdown: "Test about",
  location: null, public_email: "test@example.test", github_url: "https://github.com/example",
  linkedin_url: null, status: "draft",
};
before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    INSERT INTO auth.users VALUES ('${ADMIN}'), ('${OTHER}');`);
  for (const file of ["202611060001_public_content.sql", "202611060002_profile_editing.sql"]) {
    await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  await db.exec(`INSERT INTO portfolio_private.admin_users (user_id) VALUES ('${ADMIN}');
    INSERT INTO public.profiles (display_name, headline) VALUES ('TEST original', 'Original headline');`);
});
after(async () => db.close());
async function asUser(uid, action, prepare = "") {
  await db.exec("BEGIN;");
  try {
    if (prepare) await db.exec(prepare);
    await db.exec(`SET LOCAL ROLE authenticated;`);
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [uid]);
    return await action();
  } finally { await db.exec("ROLLBACK;"); }
}
async function readProfile() {
  return (await db.query("SELECT public.admin_get_profile() AS profile")).rows[0].profile;
}
async function save(data = payload, revision = 0, requestId = randomUUID()) {
  return (await db.query("SELECT public.admin_save_profile($1::jsonb, $2::bigint, $3::uuid) AS profile", [JSON.stringify(data), revision, requestId])).rows[0].profile;
}

test("administrator reads a draft without publishing it", async () => {
  await asUser(ADMIN, async () => {
    const row = await readProfile(); assert.equal(row.display_name, "TEST original"); assert.equal(row.status, "draft");
  });
});
test("ordinary users cannot read or save through admin RPCs", async () => {
  await assert.rejects(asUser(OTHER, readProfile), /Administrator access required/);
  await assert.rejects(asUser(OTHER, () => save()), /Administrator access required/);
});
test("anonymous role has no permission to invoke either RPC", async () => {
  for (const signature of ["public.admin_get_profile()", "public.admin_save_profile(jsonb,bigint,uuid)"]) {
    const { rows } = await db.query("SELECT has_function_privilege('anon', $1, 'EXECUTE') AS allowed", [signature]);
    assert.equal(rows[0].allowed, false);
  }
});
test("authenticated role cannot bypass audited RPCs with direct writes", async () => {
  await assert.rejects(asUser(ADMIN, () => db.exec("UPDATE public.profiles SET display_name = 'bypass'")), /permission denied/);
});
test("administrator creates a profile and audit event atomically", async () => {
  await asUser(ADMIN, async () => {
    const row = await save(payload, null);
    assert.equal(row.revision, 1); assert.equal(row.display_name, payload.display_name);
    await db.exec("RESET ROLE;");
    const logs = (await db.query("SELECT * FROM portfolio_private.content_audit_logs")).rows;
    assert.equal(logs.length, 1); assert.equal(logs[0].actor_id, ADMIN);
    assert.equal(logs[0].before_data, null); assert.equal(logs[0].action, "profile.create");
    assert.equal(logs[0].after_data.id, row.id);
  }, "DELETE FROM public.profiles;");
});
test("an update preserves identity and records before and after snapshots", async () => {
  await asUser(ADMIN, async () => {
    const before = await readProfile();
    const row = await save({ ...payload, status: "published" });
    assert.equal(row.id, before.id); assert.equal(row.revision, 1); assert.equal(row.status, "published");
    await db.exec("RESET ROLE;");
    const logs = (await db.query("SELECT * FROM portfolio_private.content_audit_logs")).rows;
    assert.equal(logs[0].before_data.display_name, "TEST original");
    assert.equal(logs[0].after_data.display_name, payload.display_name);
    assert.equal(logs[0].action, "profile.update");
  });
});
test("repeating the same request does not change revision or duplicate audit", async () => {
  await asUser(ADMIN, async () => {
    const id = randomUUID();
    assert.deepEqual(await save(payload, 0, id), await save(payload, 0, id));
    await db.exec("RESET ROLE;");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM portfolio_private.content_audit_logs")).rows[0].n, 1);
  });
});
test("reusing a request ID for different content is rejected", async () => {
  await assert.rejects(asUser(ADMIN, async () => {
    const id = randomUUID(); await save(payload, 0, id);
    await save({ ...payload, display_name: "TEST different" }, 0, id);
  }), /Request ID already used/);
});
test("a stale edit cannot overwrite a newer save", async () => {
  await assert.rejects(asUser(ADMIN, async () => { await save(); await save({ ...payload, headline: "stale" }); }), /Profile has changed/);
});
test("missing or wrong expected revision fails closed", async () => {
  await assert.rejects(asUser(ADMIN, () => save(payload, null)), /Profile has changed/);
  await assert.rejects(asUser(ADMIN, () => save(payload, 99)), /Profile has changed/);
  await assert.rejects(asUser(ADMIN, () => save(payload, 0), "DELETE FROM public.profiles;"), /Profile has changed/);
});
test("required fields, unknown fields, types, lengths, state and URLs are validated inside SQL", async () => {
  const cases = [
    null, [], { display_name: "missing fields" }, { ...payload, injected: true },
    { ...payload, display_name: " " }, { ...payload, display_name: "x".repeat(121) },
    { ...payload, headline: "x".repeat(201) }, { ...payload, about_markdown: "x".repeat(20001) },
    { ...payload, location: 42 }, { ...payload, location: "x".repeat(121) },
    { ...payload, public_email: "bad email" }, { ...payload, public_email: "x".repeat(255) },
    { ...payload, github_url: "javascript:alert(1)" }, { ...payload, github_url: "https://user:pass@example.com" },
    { ...payload, github_url: "x".repeat(2049) }, { ...payload, linkedin_url: false },
    { ...payload, status: "unknown" },
  ];
  for (const data of cases) await assert.rejects(asUser(ADMIN, () => save(data)), /Invalid profile/);
});
test("blank optional contacts are normalized to null", async () => {
  await asUser(ADMIN, async () => {
    const row = await save({ ...payload, location: " ", public_email: "", github_url: "", linkedin_url: "" });
    assert.equal(row.location, null); assert.equal(row.public_email, null); assert.equal(row.github_url, null);
  });
});
test("a failed audit insert rolls back the profile update", async () => {
  await asUser(ADMIN, async () => {
    await db.exec("SAVEPOINT before_save;");
    await assert.rejects(save(), /constraint/);
    await db.exec("ROLLBACK TO SAVEPOINT before_save;");
    const row = await readProfile(); assert.equal(row.display_name, "TEST original"); assert.equal(row.revision, 0);
  }, "ALTER TABLE portfolio_private.content_audit_logs ADD CONSTRAINT test_reject_audit CHECK (action <> 'profile.update');");
});
test("private audit history and admin membership are inaccessible to client roles", async () => {
  for (const table of ["content_audit_logs", "admin_users"]) {
    await assert.rejects(asUser(ADMIN, () => db.query(`SELECT * FROM portfolio_private.${table}`)), /permission denied/);
  }
});
test("only one configured administrator is allowed", async () => {
  await db.exec("BEGIN;");
  try { await assert.rejects(db.exec(`INSERT INTO portfolio_private.admin_users (user_id) VALUES ('${OTHER}')`), /constraint/); }
  finally { await db.exec("ROLLBACK;"); }
});
test("publishing makes the updated record public; withdrawing hides it", async () => {
  await asUser(ADMIN, async () => {
    await save({ ...payload, status: "published" });
    await db.exec("SET LOCAL ROLE anon;");
    assert.equal((await db.query("SELECT display_name FROM public.profiles")).rows.length, 1);
    await db.exec("SET LOCAL ROLE authenticated;");
    await save({ ...payload, status: "draft" }, 1);
    await db.exec("SET LOCAL ROLE anon;");
    assert.equal((await db.query("SELECT * FROM public.profiles")).rows.length, 0);
  });
});
