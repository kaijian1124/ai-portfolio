# Backend

FastAPI admin API, grounded chat and durable ingestion worker. See [setup](../docs/next-steps.md) and [operations](../docs/operations.md).

Run `uv sync --frozen` then `uv run uvicorn app.main:app --reload --env-file .env --host 127.0.0.1 --port 8000`. Worker: `uv run --env-file .env python -m app.worker --max-jobs 3`.

Checks: `uv run pytest --cov=app --cov-report=term-missing`, `uv run ruff check app tests`. AI budgets default to zero. Health checks never call OpenAI and do not certify database/AI configuration.
