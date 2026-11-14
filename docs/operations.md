# Operations, evaluation and recovery

## Checks

From the respective directories:

```powershell
# backend
uv sync --frozen
uv run ruff check app tests
uv run ruff format --check app tests
uv run pytest --cov=app --cov-report=term-missing
# frontend
npm ci
npm run test:coverage
npm run build
npm run typecheck
npx playwright install chromium
npm run test:e2e
# supabase
npm ci
node --test tests/*.test.mjs
```

Database tests run in isolated PGlite PostgreSQL with the vector extension; they never seed or mutate the real Supabase project. HTTP tests mock external services and AI. Browser chat tests intercept API answers with labelled TEST fixtures. Unit coverage targets core logic; it is not a claim that every rendered page has equivalent interaction coverage. CI runs the same checks on GitHub, with browser failure traces retained seven days.

## Evaluation

For a manual retrieval baseline, open Admin → AI monitoring → Retrieval Lab
after submitting each test question in Ask AI. Use a fresh conversation for
each case except the follow-up pair. Use the same approved document versions
and model configuration when repeating a case. Record the supporting source,
its rank at each stage, whether it reached the model, what the answer cited,
and the request latency and estimated cost.

| Case | Question | Evidence or expected behavior |
| --- | --- | --- |
| PDF methodology | Besides DOJ open-source reporting, which sources did the 2024 NMLRA use? | PDF viewer page 8. Look for court documents, law enforcement consultation, FinCEN analysis of suspicious activity reports, and US regulatory enforcement actions. Run when this PDF is approved in the test corpus. |
| Project attribution | How does Kai Jian evaluate the retrieval quality and latency of this AI Portfolio chatbot? | Use the AI Portfolio note. Keep tooling and previous checks distinct from measured quality results. |
| Missing evidence | What was AI Portfolio's measured answer accuracy on 100 reviewed questions? | If this fact is absent from the test corpus, state that the figure cannot be verified. |
| Follow-up | Compare TalentBank and AI Portfolio by their main technologies. Then ask: What about the second project? | Use one conversation. Identify the second project from the first answer's actual order and verify it against current published sources. |

These are acceptance cases, with no measured scores yet.

From backend, after configuration and adding real published content:

```powershell
uv run --env-file .env python -m app.evaluation --generate evaluation-results/cases.jsonl
```

Review every generated case against current facts. Edit the question, required_terms, expected_source_ids and expect_refusal; set reviewed=true only after verification. Add technical-document, multilingual, missing-evidence, changed/deleted-source, contradiction and prompt-injection cases. For deeper inspection, record manual assessment of factual support separately. Use at least 50 representative, reviewed cases once sufficient actual content exists; do not fabricate personal facts just to reach a case count. The generator intentionally does not assert its candidates are correct.

```powershell
uv run --env-file .env python -m app.evaluation --run evaluation-results/cases.jsonl --allow-paid
```

This calls the normal chat endpoint and consumes the normal chat budget/rate limit. Set EVALUATION_API_BASE_URL for a deployed API, otherwise localhost:8000. Keep the proxy secret private. It runs sequentially, pauses between cases, and writes a local JSON report plus aggregate metrics to admin monitoring. Nothing runs paid evaluations automatically in CI.

Metrics: refusal accuracy, source recall, required-term coverage, citation rate, answer rate and latency. Lexical coverage is only a proxy for answer relevance, and source recall depends on reviewed ground truth. These are not RAGAS faithfulness scores or proof of correctness. Compare reports on the same reviewed dataset/hash after changing prompts, chunking or retrieval settings. Regenerate/review when published facts change. No baseline quality score is claimed before running on real content.

## Troubleshooting

- Public Profile works but projects return unavailable: apply remaining catalog SQL first. API readiness does not test that schema.
- Admin 401/403: check server ADMIN_USER_ID, actual Auth user, and private admin membership; never put administrator authority in editable user_metadata.
- All new admin content fails: check schema RPC execution grants and migrations. Only approved admin JWTs can call admin RPCs; client roles have no direct write grants.
- Upload 503: check backend secret key, bucket names, and Render health. Check the list before retrying an uncertain response. Definitive hash duplicates are safe; an ambiguous Storage timeout may leave an orphan.
- Pending job: check Actions enabled/default branch, worker secrets and budget. Run workflow manually. It is not processed by the health probe.
- Failed document: inspect error code, verify real text PDF/DOCX, size/page limits, API key and embedding budget; use Re-index after fixing configuration. A failed new version does not replace the last good active index.
- Chat 429: daily quota, per-IP rate or concurrent-request limit. Do not automatically resend paid questions.
- Chat 503: server keys, matching proxy secrets, pricing, or missing migration. AI initialization is separate from the API health check.
- Resume download 503: Vercel needs its server-only Supabase secret key; only active published metadata can be signed.
- Cleanup delayed: restore the worker schedule and run one retention cycle; 30/90-day rules are not self-executing database TTLs.
- Browser tests fail before navigation with spawn UNKNOWN on this Windows machine: browser launch is blocked in this environment. Run the committed suite in GitHub Linux CI or a permitted local shell. Do not disable endpoint protection to make the tests pass.

## Backup and rollback

Back up both database and Storage originals; a database dump alone does not include file objects. Keep backups encrypted, access limited, and verify restoration to a separate Supabase test project. Include public tables, portfolio_private, Auth identity references and storage metadata in a provider-supported database backup, and copy actual Storage objects separately with owner credentials. Supabase platform backup availability depends on your plan; verify current dashboard features before relying on them.

Record applied migration filenames in deployment notes. For an empty disaster-recovery project, apply all six migrations in order, recreate the Auth admin, and bootstrap the *new* verified UID; do not blindly copy an old Auth UID. Restore metadata and matching objects coherently, then test the published/draft and private/public boundaries before switching traffic. For an existing project use forward migrations, not destructive replay.

A frontend/API release can be rolled back through its host dashboard while preserving backward-compatible schema. Data rollback uses audit snapshots or a reviewed corrective migration. Soft-deleted records restore through the UI. Resume versions can be reactivated; documents can be replaced/reindexed and reapproved. Never delete current versions/chunks manually to fix a queue problem.

Review unreferenced Storage objects by comparing paths against resume metadata, project assets and *all* document versions. Export the candidate list first; investigate uncertain transactions and apply an age buffer. No automatic orphan purge is provided because it can destroy a valid upload after an ambiguous network response. Permanent purge is an explicit owner maintenance action.

## Monitoring and safety

Review /admin/monitoring for estimated cost, input/output/embedding tokens, failures, latency, feedback, jobs and latest reviewed evaluation. /admin/activity shows audit metadata. Provider logs should not contain raw tokens, keys or chat text. The code returns sanitized external errors; it does not print secrets or full prompts.

Rotate exposed credentials at their provider, update Render/Vercel/Actions, redeploy and verify; removing a leaked value from the latest commit does not invalidate it. Keep service keys out of NEXT_PUBLIC_, GitHub source and browser storage. Do not enable signup or broad Storage write policies to work around an admin failure.
