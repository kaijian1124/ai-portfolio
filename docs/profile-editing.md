> Historical milestone notes. For the current complete setup, use [next-steps.md](next-steps.md).

# Profile editing: database milestone

Status: user confirmed hosted SQL applied. Hosted revision field returned HTTP 200 and anonymous admin RPC returned 401. FastAPI and the editing UI are implemented and locally tested. Real-account save/publish/withdraw verification is pending user action.

## Apply

Use only the ai-portfolio Supabase project (nabkcsocbchmosnqyznn).

Open supabase/setup-profile.local.sql, copy the entire file into a NEW Supabase SQL Editor query and run once. This local file combines migrations/202611060002_profile_editing.sql and the configured administrator membership in a single transaction. Do NOT separately execute the versioned migration and then execute the combined file.

The environment-specific setup file is ignored by Git and contains only an administrator UID, no key/password. The versioned migration contains no identities. Existing Profile rows and other portfolio data are preserved. The first schema migration must already be applied.

If the administrator account is absent, or any statement fails, the entire transaction rolls back. Stop and inspect the error; do not drop tables or force reruns. A successful applied migration must not be edited or rerun. As with migration 001, reconcile the manual application with Supabase CLI history before introducing db push.

## What changes

- profiles.revision is added with default 0, preserving existing rows.
- portfolio_private.admin_users binds one Auth identity. Membership is removed if that Auth account is deleted.
- portfolio_private.content_audit_logs records the authenticated actor, before/after snapshots, request payload and request ID. It is not exposed through Data API and client roles cannot read/change it directly.
- public.admin_get_profile() reads the singleton even when draft/archived, but only after checking the database administrator membership.
- public.admin_save_profile(p_profile jsonb, p_expected_revision bigint, p_request_id uuid) performs validated full-replacement content updates and audit insertion in one transaction.
- Content and audit are atomic. If an audit write fails, the profile change rolls back.
- All direct table write grants remain revoked. Ordinary authenticated users may reach the RPC but fail its administrator check; anon has no EXECUTE privilege.

The two RPCs are SECURITY DEFINER with an empty search_path and fully qualified relations. They deliberately access private tables after verifying auth.uid(). The helper is not callable by client roles. Never grant general access to portfolio_private or expose that schema in Data API settings.

The application will submit saves through FastAPI, forwarding the verified user's access token and the publishable key. A secret/service-role key is not needed. An administrator possessing their own token can also invoke the narrow RPC directly; database validation, membership, versioning and audit invariants still apply there. Never rely only on frontend/backend validation for an exposed RPC.

## Save contract

The profile object contains exactly display_name, headline, about_markdown, location, public_email, github_url, linkedin_url, status. display_name/headline/about_markdown/status are strings. Optional fields are strings or null; blank optional fields become null. Status is draft/published/archived. All fields of published content are public; only enter contact information intended for public display.

Limits: display_name 120 characters (not blank), headline 200, about_markdown 20000, location 120, public_email 254, URLs 2048 and HTTPS without embedded credentials/whitespace. Future FastAPI validation adds normal application-level URL/email validation too. Markdown remains untrusted input and must be rendered safely.

Every save carries the loaded revision (null only for creation) and a UUID request ID. A stale revision raises SQLSTATE 40001. The same request ID and exact payload returns the original saved result, without another revision/audit event. A reused request ID with a different payload conflicts. New user edits need new IDs; uncertain-result retries must retain the same ID and payload. Singleton saves are serialized using a transaction-scoped advisory lock.

Audit snapshots can contain historical public contacts. They stay private; administrator access/removal and data retention need explicit operational handling.

## Verification

Run from supabase: npm test. All 33 tests passed, including existing public RLS tests and the new private authorization, revision, idempotency and audit rollback tests. Test data exists only in isolated PGlite instances.

Hosted verification after the setup runs can inspect portfolio_private.admin_users in SQL Editor (do not enable public access) and confirm profiles has revision. No hosted Profile save has been attempted by the agent. The authenticated backend routes and form are implemented; perform the real-account checklist below.

The frontend/backend server allowlists and database membership must name the same user. A mismatch fails closed. Changing administrator identity requires updating all three deliberately; there is no self-service privilege escalation path.


## Application routes and verification

- GET /api/v1/admin/profile reads the singleton through admin_get_profile, including drafts. It returns {profile: null} only when no record exists.
- PUT /api/v1/admin/profile sends the validated profile, expected_revision and request_id to admin_save_profile. FastAPI verifies the Supabase access token and administrator identity first.
- /admin/profile loads through FastAPI and does not render a blank form when loading fails. Tokens remain server-side and are not passed to the Client Component.
- The form edits display name, headline, About, location, public email, HTTPS GitHub/LinkedIn links, and visibility. Public About is rendered as escaped plain text at this stage.
- A confirmed save updates the form's revision and rotates the request ID. A network/server failure retains the exact payload, revision and key for manual retry and freezes editing. A 409 blocks another save until reload. Reloading intentionally discards unsaved text.
- The status dropdown explicitly controls visibility: draft/archived hides the singleton; published exposes its public fields. This is a single current record, not a separate unpublished working copy of a published revision.
- Responses are no-store; public page reloads get fresh data without redeployment. revalidatePath also invalidates the public route after confirmed saves.

Manual acceptance with your account:

1. Open http://localhost:3000/admin/profile and sign in if prompted.
2. Verify your existing data loads; edit the headline or About and save as Draft. The public page must hide the profile after refresh.
3. Change visibility to Published and save. Refresh the public page to see your latest name/headline/About/location.
4. Run supabase/verify_profile_audit.sql in SQL Editor if you want to inspect the latest private audit events without displaying full snapshots.
5. Open the editor in two tabs, save from one, then save the stale other tab: it must report a conflict and must not overwrite the newer save.

Tests: 59 backend tests passed and Ruff passed; 88 frontend tests passed, including 5 interactive form tests, plus build/typecheck. Core logic meets configured coverage thresholds. Database's 33 tests passed in the previous slice. Live checks confirmed the revision column (200), anonymous RPC rejection (401), signed-out editing-page redirect to login, and tokenless backend rejection (401). Authenticated cloud saves are intentionally left to the owner; no fake or test content was written to Supabase.
