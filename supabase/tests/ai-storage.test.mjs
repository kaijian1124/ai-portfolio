import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
const db=new PGlite({extensions:{vector}});const admin='11111111-1111-4111-8111-111111111111';
before(async()=>{await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid primary key);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;INSERT INTO auth.users VALUES('${admin}');CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
for(const name of ['202611060001_public_content.sql','202611060002_profile_editing.sql','202611070001_catalog.sql','202611070002_ai_storage.sql','202611070003_buckets.sql','202611070004_resume_import.sql','202611090001_rag_enhancement.sql','202611140001_admin_ingestion_chunks.sql'])await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
await db.exec(`INSERT INTO portfolio_private.admin_users(user_id) VALUES('${admin}')`)});
after(async()=>db.close());
async function rpc(name,args={}){const keys=Object.keys(args);const sql='SELECT public.'+name+'('+keys.map((k,i)=>k+'=> $'+(i+1)).join(',')+') AS result';return (await db.query(sql,keys.map(k=>k==='p_candidate_ids'?'{'+args[k].join(',')+'}':typeof args[k]==='object'&&args[k]!==null?JSON.stringify(args[k]):args[k]))).rows[0].result}
async function transaction(fn){await db.exec('BEGIN');try{return await fn()}finally{await db.exec('ROLLBACK')}}
async function owner(){await db.exec('SET LOCAL ROLE authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[admin])}
async function service(){await db.exec('SET LOCAL ROLE service_role')}
async function register(){await owner();return(await rpc('admin_register_upload',{p_kind:'knowledge',p_title:'TEST ONLY',p_filename:'test.pdf',p_path:randomUUID()+'/'+randomUUID()+'.pdf',p_sha256:'a'.repeat(64),p_size:100})).record}
test('admins can inspect completed private chunks while reindexing, scoped to the exact version',()=>transaction(async()=>{
const doc=await register();await service();const job=await rpc('worker_claim_job');
const args={p_document:doc.id,p_version:job.version_id};
const model='text-embedding-3-small', embedding=Array(1536).fill(0);embedding[0]=1;
await owner();assert.equal((await rpc('admin_ingestion_chunks',args)).index_id,null);
await service();await rpc('worker_store_chunks',{p_job:job.id,p_lease:job.lease_token,p_chunks:[
 {ordinal:0,text:'First excerpt',page:1,heading:'Overview',embedding},
 {ordinal:1,text:'Second excerpt',page:2,heading:'Methods',table_header:'Test results',embedding},
],p_model:model});
await rpc('worker_finish_job',{p_job:job.id,p_lease:job.lease_token,p_model:model});
await owner();
await rpc('admin_reindex_document',{p_id:doc.id,p_request_id:randomUUID()});
const result=await rpc('admin_ingestion_chunks',{...args,p_offset:1,p_limit:1});
assert.equal(result.index_id,job.id);
assert.equal(result.total,2);
assert.equal(result.filename,'test.pdf');
assert.deepEqual(result.chunks,[{ordinal:1,page:2,heading:'Methods',text_content:'Second excerpt',table_header:'Test results'}]);
await db.exec('SAVEPOINT wrong_version');
await assert.rejects(rpc('admin_ingestion_chunks',{...args,p_version:randomUUID()}),/not found/i);
await db.exec('ROLLBACK TO SAVEPOINT wrong_version');
await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[randomUUID()]);
await db.exec('SAVEPOINT not_admin');
await assert.rejects(rpc('admin_ingestion_chunks',args),/Administrator access required/);
await db.exec('ROLLBACK TO SAVEPOINT not_admin');
await db.exec('SET LOCAL ROLE anon');
await assert.rejects(rpc('admin_ingestion_chunks',args),/permission denied/);
}));
test('knowledge ingestion remains private until approval, then respects immediate withdrawal',()=>transaction(async()=>{
const doc=await register();await service();const job=await rpc('worker_claim_job');assert.equal(job.document_id,doc.id);const embedding=Array(1536).fill(0);embedding[0]=1;
const model='text-embedding-3-small';
await rpc('worker_store_chunks',{p_job:job.id,p_lease:job.lease_token,p_chunks:[{ordinal:0,text:'TEST evidence',page:1,heading:'Methods',embedding}],p_model:model});
assert.equal(await rpc('worker_finish_job',{p_job:job.id,p_lease:job.lease_token,p_model:model}),true);
assert.deepEqual(await rpc('search_knowledge',{p_embedding:embedding,p_model:model}),[]);
await owner();await rpc('admin_catalog_mutate',{p_resource:'documents',p_id:doc.id,p_data:{approved_for_chat:true},p_expected_revision:doc.revision+1,p_request_id:randomUUID()});
await service();assert.equal((await rpc('search_knowledge',{p_embedding:embedding,p_model:model})).length,1);
const unrelated=Array(1536).fill(0);unrelated[1]=1;
const hits=await rpc('hybrid_knowledge',{p_embedding:unrelated,p_model:model,p_query:'evidence'});
assert.equal(hits.length,1);assert.equal(await rpc('knowledge_current',{p_ids:[hits[0].id]}),true);
await owner();await rpc('admin_catalog_mutate',{p_resource:'documents',p_id:doc.id,p_data:{},p_expected_revision:doc.revision+2,p_request_id:randomUUID(),p_operation:'delete'});
await service();assert.deepEqual(await rpc('search_knowledge',{p_embedding:embedding,p_model:model}),[]);
assert.equal(await rpc('knowledge_current',{p_ids:[hits[0].id]}),false);
assert.equal(await rpc('public_source',{p_id:hits[0].id}),null);
}));
test('expired or forged worker leases cannot write chunks',()=>transaction(async()=>{await register();await service();const job=await rpc('worker_claim_job');await assert.rejects(rpc('worker_store_chunks',{p_job:job.id,p_lease:randomUUID(),p_chunks:[],p_model:'test'}),/lease/)}));
test('chat admission refuses duplicate session turns and over-budget reservations',()=>transaction(async()=>{await service();const session=randomUUID();await rpc('chat_admit',{p_session:session,p_request:randomUUID(),p_ip_hash:'TEST',p_budget:.05,p_reserve:.05});await assert.rejects(rpc('chat_admit',{p_session:session,p_request:randomUUID(),p_ip_hash:'TEST',p_budget:.05,p_reserve:.05}),/pending request/)}));
test('chat admission enforces the daily budget across sessions',()=>transaction(async()=>{await service();await rpc('chat_admit',{p_session:randomUUID(),p_request:randomUUID(),p_ip_hash:'TEST',p_budget:.05,p_reserve:.05});await assert.rejects(rpc('chat_admit',{p_session:randomUUID(),p_request:randomUUID(),p_ip_hash:'TEST',p_budget:.05,p_reserve:.05}),/budget/)}));
test('private service operations are not callable by anonymous users',()=>transaction(async()=>{await db.exec('SET LOCAL ROLE anon');await assert.rejects(rpc('worker_claim_job'),/permission denied/)}));
test('storage buckets are private except explicitly public project images',async()=>{const rows=(await db.query('SELECT id,public FROM storage.buckets ORDER BY id')).rows;assert.deepEqual(rows,[{id:'portfolio-images',public:true},{id:'portfolio-knowledge',public:false},{id:'portfolio-resumes',public:false}])});


test('monitoring returns honest empty evaluation and only service can save reports',()=>transaction(async()=>{
await owner();const monitor=await rpc('admin_monitoring');assert.equal(monitor.evaluation,null);assert.equal(Number(monitor.average_citations),0);
await service();await rpc('evaluation_save_report',{p_dataset_hash:'a'.repeat(64),p_case_count:1,p_metrics:{source_recall:1}});
await owner();assert.equal((await rpc('admin_monitoring')).evaluation.case_count,1);
}));
test('indexing budget zero prevents paid work and unsettled leases count against the budget',()=>transaction(async()=>{
await register();await service();const job=await rpc('worker_claim_job');
assert.equal(await rpc('worker_reserve_budget',{p_job:job.id,p_lease:job.lease_token,p_budget:0,p_reserve:.01}),false);
assert.equal(await rpc('worker_reserve_budget',{p_job:job.id,p_lease:job.lease_token,p_budget:.01,p_reserve:.01}),true);
assert.equal(await rpc('worker_settle_budget',{p_lease:job.lease_token,p_tokens:10,p_cost:.0001}),true);
assert.equal(await rpc('worker_settle_budget',{p_lease:job.lease_token,p_tokens:10,p_cost:.0001}),false);
}));


test('reindexing the same file supersedes an older index lease',()=>transaction(async()=>{
const doc=await register();await service();const old=await rpc('worker_claim_job');
await owner();await rpc('admin_reindex_document',{p_id:doc.id,p_request_id:randomUUID()});
await service();assert.equal(await rpc('worker_finish_job',{p_job:old.id,p_lease:old.lease_token,p_model:'TEST'}),false);
const current=await rpc('worker_claim_job');assert.notEqual(current.id,old.id);assert.equal(current.version_id,old.version_id);
}));
test('model switch waits for a complete candidate and never inherits approval for changed bytes',()=>transaction(async()=>{
const doc=await register(),embedding=Array(1536).fill(0);embedding[0]=1;
await service();
async function finish(model,text) {
 const job=await rpc('worker_claim_job');
 await rpc('worker_store_chunks',{p_job:job.id,p_lease:job.lease_token,p_chunks:[{ordinal:0,text,heading:'Pilot',embedding}],p_model:model});
 assert.equal(await rpc('worker_finish_job',{p_job:job.id,p_lease:job.lease_token,p_model:model}),true);
}
await finish('text-embedding-3-small','Original evidence');
await owner();await rpc('admin_catalog_mutate',{p_resource:'documents',p_id:doc.id,p_data:{approved_for_chat:true},p_expected_revision:doc.revision+1,p_request_id:randomUUID()});
await service();
await db.exec('SAVEPOINT premature');
await assert.rejects(rpc('rag_switch_embedding',{p_model:'new-embedding-model',p_price:.1}),/incomplete/);
await db.exec('ROLLBACK TO SAVEPOINT premature');
assert.equal((await rpc('rag_index_configuration')).model,'text-embedding-3-small');
await owner();await rpc('admin_reindex_document',{p_id:doc.id,p_request_id:randomUUID()});
await service();await finish('new-embedding-model','Original evidence');
assert.equal((await rpc('hybrid_knowledge',{p_embedding:embedding,p_model:'text-embedding-3-small',p_query:'evidence'})).length,1);
await rpc('rag_switch_embedding',{p_model:'new-embedding-model',p_price:.1});
assert.equal((await rpc('rag_index_configuration')).model,'new-embedding-model');
assert.equal(await rpc('hybrid_knowledge',{p_embedding:embedding,p_model:'text-embedding-3-small',p_query:'evidence'}),null);
assert.equal((await rpc('hybrid_knowledge',{p_embedding:embedding,p_model:'new-embedding-model',p_query:'evidence',p_heading:'Pilot'})).length,1);
assert.deepEqual(await rpc('hybrid_knowledge',{p_embedding:embedding,p_model:'new-embedding-model',p_query:'evidence',p_heading:'Other'}),[]);
await owner();await rpc('admin_register_upload',{p_kind:'knowledge',p_title:'Replacement',p_filename:'replacement.md',p_path:randomUUID()+'/'+randomUUID()+'.md',p_sha256:'c'.repeat(64),p_size:100,p_replace_id:doc.id});
await service();await finish('new-embedding-model','Replacement evidence');
assert.deepEqual(await rpc('hybrid_knowledge',{p_embedding:embedding,p_model:'new-embedding-model',p_query:'evidence'}),[]);
}));
test('completed conversations preserve user then assistant order and private feedback',()=>transaction(async()=>{
await service();const session=randomUUID(),request=randomUUID();await rpc('chat_admit',{p_session:session,p_request:request,p_ip_hash:'TEST',p_budget:1,p_reserve:.05});
const message=await rpc('chat_finish',{p_request:request,p_question:'TEST question',p_answer:'TEST answer',p_sources:[],p_prompt:1,p_output:1,p_embedding:0,p_cost:.001,p_latency:10});
const history=await rpc('chat_history',{p_session:session});assert.deepEqual(history.map(row=>row.role),['user','assistant']);
const safeHistory=await rpc('rag_history',{p_session:session});assert.equal(safeHistory[1].content,null);
assert.equal(await rpc('chat_vote',{p_session:randomUUID(),p_message:message,p_vote:1}),false);assert.equal(await rpc('chat_vote',{p_session:session,p_message:message,p_vote:1}),true);
}));


test('resume imports add selected drafts only, skip existing content and replay safely',()=>transaction(async()=>{
 await owner();const upload=await rpc('admin_register_upload',{p_kind:'resume',p_title:'TEST Resume',p_filename:'test.pdf',p_path:randomUUID()+'/'+randomUUID()+'.pdf',p_sha256:'b'.repeat(64),p_size:100});
 const existing=await rpc('admin_catalog_mutate',{p_resource:'skills',p_id:null,p_data:{name:'Python',description:'KEEP EXISTING',status:'published'},p_expected_revision:null,p_request_id:randomUUID()});
 const request=randomUUID(),skill=randomUUID(),project=randomUUID();
 assert.equal((await rpc('admin_resume_import_begin',{p_resume:upload.record.id,p_request:request,p_budget:1,p_reserve:.05})).claimed,true);
 assert.equal((await rpc('admin_resume_import_begin',{p_resume:upload.record.id,p_request:request,p_budget:1,p_reserve:.05})).claimed,false);
 await service();await rpc('resume_import_finish',{p_request:request,p_candidates:[{id:skill,resource:'skills',data:{name:'Python',description:'OVERWRITE ATTEMPT',status:'published'},evidence_quote:'TEST'},{id:project,resource:'projects',data:{title:'TEST addition',slug:'test-addition',status:'published'},evidence_quote:'TEST'}],p_prompt:10,p_output:10,p_cost:.001});
 await owner();assert.equal((await rpc('admin_resume_import_get',{p_resume:upload.record.id,p_request:request})).status,'completed');
 const result=await rpc('admin_resume_import_apply',{p_resume:upload.record.id,p_request:request,p_candidate_ids:[skill,project]});assert.equal(result.created.length,1);assert.equal(result.skipped,1);
 assert.deepEqual(await rpc('admin_resume_import_apply',{p_resume:upload.record.id,p_request:request,p_candidate_ids:[skill,project]}),result);
 const kept=await rpc('admin_catalog_get',{p_resource:'skills',p_id:existing.id});assert.equal(kept.description,'KEEP EXISTING');assert.equal(kept.status,'published');assert.equal(kept.revision,existing.revision);
 assert.equal((await rpc('admin_catalog_get',{p_resource:'projects',p_id:result.created[0].id})).status,'draft');
 await db.exec('SET LOCAL ROLE anon');await assert.rejects(rpc('admin_resume_import_get',{p_resume:upload.record.id,p_request:request}),/permission denied/);
}));
