import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite(); const admin = '11111111-1111-4111-8111-111111111111';
before(async () => {
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; INSERT INTO auth.users VALUES('${admin}');`);
 for(const file of ['202611060001_public_content.sql','202611060002_profile_editing.sql','202611070001_catalog.sql']) await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 await db.exec(`INSERT INTO portfolio_private.admin_users(user_id) VALUES('${admin}')`);
});
after(async()=>db.close());
async function run(fn,uid=admin){await db.exec('BEGIN;SET LOCAL ROLE authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[uid]);try{return await fn()}finally{await db.exec('ROLLBACK')}}
const project={title:'TEST ONLY',slug:'test-project',summary:'Test',body_markdown:'Test',github_url:null,demo_url:null,is_featured:false,status:'draft',sort_order:0,category:'AI',technologies:['Python']};
async function save(resource,id,data,revision,request=randomUUID(),operation='save'){return (await db.query('SELECT public.admin_catalog_mutate($1,$2::uuid,$3::jsonb,$4::bigint,$5::uuid,$6) AS result',[resource,id,JSON.stringify(data),revision,request,operation])).rows[0].result}
test('catalog supports audited create/update and stale-version refusal',()=>run(async()=>{const row=await save('projects',null,project,null);assert.equal(row.revision,1);const updated=await save('projects',row.id,{...project,title:'TEST updated'},1);assert.equal(updated.revision,2);await assert.rejects(save('projects',row.id,project,1),/changed/)}));
test('catalog retries are idempotent and unrelated resources cannot be targeted',()=>run(async()=>{const request=randomUUID();const row=await save('projects',null,project,null,request);assert.deepEqual(row,await save('projects',null,project,null,request));await assert.rejects(save('auth.users',null,{},null),/resource/)}));
test('soft deletion hides published rows and leaves an audit event',()=>run(async()=>{const row=await save('projects',null,{...project,status:'published'},null);await save('projects',row.id,{},1,randomUUID(),'delete');await db.exec('SET LOCAL ROLE anon');assert.equal((await db.query('SELECT * FROM public.projects')).rows.length,0);await db.exec('RESET ROLE');assert.equal((await db.query('SELECT count(*)::int AS n FROM portfolio_private.audit_events')).rows[0].n,2)}));
test('ordinary users cannot call administrative catalog methods',()=>run(async()=>{await assert.rejects(save('projects',null,project,null),/Administrator/ )},'22222222-2222-4222-8222-222222222222'));
test('existing profile RPC continues to work after catalog migration',()=>run(async()=>{const p={display_name:'TEST',headline:'',about_markdown:'',location:null,public_email:null,github_url:null,linkedin_url:null,status:'draft'};const row=(await db.query('SELECT public.admin_save_profile($1::jsonb,NULL,$2::uuid) AS p',[JSON.stringify(p),randomUUID()])).rows[0].p;assert.equal(row.revision,1)}));
