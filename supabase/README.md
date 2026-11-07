# Database milestone 1: public content

Remote application status: user confirmed migration applied. Hosted anonymous Data API read checks passed for all five tables (HTTP 200, no visible rows). Local SQL/RLS tests passed. Hosted write attempts and Auth integration have not been tested.

## Tables

| Table | Purpose | Main fields |
| --- | --- | --- |
| profiles | One portfolio owner | display_name, headline, about_markdown, location, public_email, github_url, linkedin_url |
| skills | Public technical skills | name, category, description |
| projects | Project list and detail | unique slug, title, summary, body_markdown, github_url, demo_url, is_featured |
| experiences | Work experience | company, job_title, location, started_on, ended_on, description_markdown |
| education | Education | institution, qualification, field_of_study, started_on, ended_on, description_markdown |

All tables have UUID primary keys, draft/published/archived status, sort_order, created_at and updated_at. New rows default to draft. The database maintains updated_at. Profiles has an additional singleton constraint, limiting it to one row. Date ranges cannot end before they begin; null ended_on means ongoing.

These five content types are independent at this milestone; do not invent foreign keys between unrelated records. Project technology relationships, images, Resume versioning, knowledge documents and chat have separate upcoming migrations.

## Access model

- anon and authenticated have SELECT privileges only.
- RLS permits SELECT only when status = published.
- All columns of a published row are public. Do not put internal notes or private contact information in these tables.
- Admin write grants, backend authorization, and audit logging are implemented together in a later milestone. Logging in alone does not grant content editing.
- The trigger helper is in portfolio_private, which must remain outside Data API exposed schemas.
- No personal data or production sample data is inserted by this migration.

## Apply once

1. Confirm the selected Supabase project is ai-portfolio, ref nabkcsocbchmosnqyznn.
2. Open SQL Editor and create a new query named 001_public_content.
3. Paste migrations/202611060001_public_content.sql and run the entire file once.
4. Success with no rows is expected. Refresh Table Editor to see the five empty tables.
5. In another query, run verify_public_content.sql. Review all result sets: five RLS-enabled tables, SELECT policies, SELECT=true and write permissions=false.

The migration uses a transaction. If any statement fails, capture the error and stop; do not delete existing tables or force a retry. Once successfully applied, do not rerun or edit this migration. Subsequent changes belong in new migrations.

This initial manual SQL Editor step does not automatically populate the Supabase CLI migration history. Before adopting CLI db push, reconcile this version as applied and verify remote schema alignment. Do not blindly push the same migration again.

## Local tests

```powershell
cd supabase
npm ci
npm test
```

PGlite is used only as an in-memory PostgreSQL test engine. It is not the application database and adds no production service. Tests simulate Supabase API roles; they verify PostgreSQL grants, RLS filtering and constraints, but not hosted Auth, Storage, Dashboard event triggers or PostgREST routing. Live API verification follows after the user applies the migration.

Fixture rows exist only inside the test process. Never copy test fixture inserts into the cloud project.

## Reviewed Resume imports

Existing installations must run `migrations/202611070004_resume_import.sql` once after the earlier migrations. This introduces private, idempotent extraction previews and insert-only confirmation. Selected candidates become drafts; existing records are preserved. See `../docs/next-steps.md`.
