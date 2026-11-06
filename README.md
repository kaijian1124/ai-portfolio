# Dynamic AI Portfolio

A database-driven Next.js portfolio and private admin dashboard, with a FastAPI grounded assistant and a persistent document ingestion queue. Deployment target: Vercel + Render + Supabase. Personal content is edited through the admin UI; no production fixtures or hardcoded biography are required.

**Start here:** [configuration and deployment guide (中文)](docs/next-steps.md).

Implemented: public Profile/About/Skills/Experience/Education/Projects/Resume; audited admin CRUD, soft deletion/restore and conflict-safe retries; private Resume and document version management; public project images; PDF/DOCX ingestion with leases and atomic index promotion; approval-gated pgvector retrieval; English/Chinese grounded chat with source links, history, SSE status/final answer and feedback; persistent AI quotas; monitoring and reviewed evaluation tooling; Docker, CI and worker workflows.

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
