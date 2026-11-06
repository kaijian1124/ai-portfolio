> Historical milestone notes. For the current complete setup, use [next-steps.md](next-steps.md).

# Administrator authentication milestone

## Implemented

- /login: email/password sign-in using a Next.js Server Action and Supabase Auth.
- /admin: server-confirmed identity plus the server-only ADMIN_USER_ID allowlist.
- /api/v1/admin/me: FastAPI independently calls the configured Supabase /auth/v1/user endpoint and verifies the same administrator UID.
- Missing/invalid token: 401. Verified non-admin: 403. Failed upstream verification/configuration: 503.
- Proxy refreshes sessions only on /admin and /login. Pages and API endpoints still authorize independently.
- No browser Supabase Auth client or localStorage session. Server-only SSR clients store access/refresh tokens in HttpOnly cookies, SameSite=Lax; Secure is enabled in production.
- Auth fetches have per-request deadlines. Auth pages and API responses are private/no-store.
- Login/logout use Server Actions with Next.js same-origin protections and fixed redirects. Login credentials are never logged or stored in configuration.

## Configuration

ADMIN_USER_ID is configured in frontend/.env.local and backend/.env. It is server-only, without NEXT_PUBLIC_. Keep the same UID in both. Examples contain a blank field; the actual value stays in ignored local files. It identifies an Auth user, not portfolio content.

Backend uses SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY. No service-role/secret key is required for this authentication slice. All direct content-table browser writes remain disabled. Profile edits use the separately deployed audited RPC and its database administrator membership check.

## Run and verify

Restart both terminals to load the new environment:

```powershell
cd backend
uv run uvicorn app.main:app --reload --env-file .env --host 127.0.0.1 --port 8000
```

```powershell
cd frontend
npm run dev
```

Open http://localhost:3000/admin while signed out: it redirects to /login. Sign in manually with the account you created in the Supabase project. /admin should show Administrator identity verified and Backend permission verified. If the backend is sleeping/offline, it reports unavailable instead of granting a false successful check. Sign out, then revisit /admin: it must redirect to /login again.

Real password-based sign-in and user-driven sign-out are pending manual verification. Do not send the password in chat. Unit/integration tests use mocked identities and fake tokens. The live Auth smoke check rejected both missing and deliberately invalid tokens with 401. The hosted public settings check confirmed signup disabled and anonymous Auth disabled.

## Design limits and next work

This is a single-administrator allowlist in deployment configuration, not a role-management UI. Supabase Auth stores identity; trusted server configuration grants this one account application access. Never authorize from user_metadata or an unverified decoded JWT. Future admin endpoints must explicitly require the backend require_admin dependency; new protected pages and Server Actions must perform their own checks.

getUser provides fresh server confirmation at the cost of an Auth network call. getSession is used only after that verification to obtain the token for server-to-server forwarding. Public portfolio reads do not use the administrator session.

This slice uses no database migration and grants no editing permission. Audited Profile editing is now implemented; see profile-editing.md. Projects remain the next content type. Supabase Auth supplies upstream login rate controls; broader application rate limits and production hardening remain part of the deployment phase. Logout clears this browser's session and attempts local-session revocation; it does not promise instant invalidation of every previously issued JWT.

Verification: frontend 65 tests passed plus build/typecheck; backend 29 tests passed plus Ruff. Coverage thresholds apply to the tested logic and do not claim full browser-flow coverage. Browser verified the signed-out /admin redirect and login form.
