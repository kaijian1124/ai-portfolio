# Dynamic AI Portfolio

A database-driven Next.js portfolio and private admin dashboard, with a FastAPI grounded assistant and a persistent document ingestion queue. Deployment target: Vercel + Render + Supabase. Personal content is edited through the admin UI; no production fixtures or hardcoded biography are required.

**Start here:** [configuration and deployment guide (中文)](docs/next-steps.md).

Implemented: public Profile/About/Skills/Experience/Education/Projects/Resume; audited admin CRUD, soft deletion/restore and conflict-safe retries; private Resume and document version management; reviewed insert-only Resume-to-draft imports; public project images; PDF/DOCX ingestion with leases and atomic index promotion; approval-gated pgvector retrieval; English/Chinese grounded chat with source links, history, SSE status/final answer and feedback; persistent AI quotas; monitoring and reviewed evaluation tooling; Docker, CI and worker workflows.

Code is implemented locally. The new cloud migrations, service/API keys, GitHub remote, deployment and paid end-to-end AI validation still need owner setup. The application does not claim measured RAG accuracy, completed production deployment or high availability. AI budgets default to zero.

## Local development

Use Node 24, Python 3.14 and uv 0.11.3. Copy .env.example only when no actual local env exists; never overwrite filled credentials.

```powershell
cd backend
uv sync --frozen
uv run uvicorn app.main:app --reload --env-file .env --host 127.0.0.1 --port 8000
```

In another terminal:

```powershell
cd frontend
npm ci
npm run dev
```

Open http://localhost:3000. Run the worker separately with `uv run --env-file .env python -m app.worker --max-jobs 3` from backend. Scheduled processing is configured in `.github/workflows/ingestion.yml`; it is not a Render keepalive.

## Documentation

- [Architecture and security boundaries](docs/architecture.md)
- [Configuration, SQL and deployment](docs/next-steps.md)
- [Tests, evaluation, troubleshooting and recovery](docs/operations.md)

Web uploads are limited to 4 MB for Vercel compatibility. Knowledge files remain private, and extracted text reaches public AI answers only after explicit owner approval. AI output is validated before the final answer is sent; streaming is not token-by-token. Render Free and Actions schedules have cold-start/latency limitations. See the guides for actual operating boundaries.

Existing installations: apply the new `supabase/migrations/202611070004_resume_import.sql` once to enable Resume imports. PDF maximum is 300 pages; web uploads remain 4 MB. Resume extraction uses the chat budget and never updates or deletes existing content.

## RAG upgrade rollout

1. Apply `supabase/migrations/202611090001_rag_enhancement.sql` before deploying this version of the API, frontend, or indexing worker. The migration preserves already approved active indexes. It adds Markdown upload support, hybrid retrieval, and approval of an exact completed index.
2. In **Knowledge base**, wait for processing to complete before saving **AI use** approval. After an explicit reindex, save approval again to publish the new index. Existing PDF and DOCX files can be reindexed to get section-aware chunks.
3. Keep `RAG_AGENT_ENABLED=false` initially. Run a reviewed evaluation set against the hybrid path and a test deployment with the agent enabled. Check multi-project coverage, citation support, withdrawal, latency, and cost before enabling the agent in production.

**AI monitoring** shows reported token categories and the rates used for each model call. Rates are application estimates. The database controls the active query embedding model. To change models later, stage same-content reindexes for every approved document, then switch the model and indexes together through the service-only `rag_switch_embedding` RPC. The current storage format requires 1,536-dimensional vectors. Model-switch preparation requires a worker configured for the candidate embedding model and rate.
