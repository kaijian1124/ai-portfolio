# Frontend

Next.js public portfolio and admin BFF. See [setup](../docs/next-steps.md) and [architecture](../docs/architecture.md).

Run `npm ci`, `npm run dev`. Checks: `npm run test:coverage`, `npm run build`, `npm run typecheck`, `npm run test:e2e`.

Environment template: `.env.example`. `SUPABASE_SECRET_KEY`, `ADMIN_USER_ID` and `CHAT_PROXY_SECRET` are server-only; never prefix them with NEXT_PUBLIC_. Web uploads are capped at 4 MB.
