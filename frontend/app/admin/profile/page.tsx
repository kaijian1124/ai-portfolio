import { AdminNav } from "../../../components/admin-nav";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { getAdminAccess } from "../../../lib/admin-session";
import { readAdminProfile } from "../../../lib/admin-profile";
import { ProfileForm } from "../../../components/profile-form";
import { signOutAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ProfileEditorPage() {
  const access = await getAdminAccess();
  if (access.state === "unauthenticated") redirect("/login");
  if (access.state === "forbidden") redirect("/admin");
  const result =
    access.state === "authorized"
      ? await readAdminProfile(access.accessToken)
      : null;
  return (
    <main>
      <header>
        <a className="wordmark" href="/admin">
          Portfolio<span className="accent">.</span> Admin
        </a>
        <form action={signOutAction}>
          <button>Sign out</button>
        </form>
      </header>
      <AdminNav />
      <section className="admin-panel profile-panel">
        <p className="eyebrow">Content management</p>
        <h1>
          Edit profile<span className="accent">.</span>
        </h1>
        <p className="lead">
          Manage your introduction and public contact information. Every
          confirmed save is recorded in private audit history.
        </p>
        {result?.status === "ok" ? (
          <ProfileForm
            initialProfile={result.profile}
            initialRequestId={randomUUID()}
          />
        ) : (
          <div className="content-message" role="status">
            <p>
              We couldn&apos;t load the profile. Check that the backend is
              running and the Profile setup SQL has completed.
            </p>
            <a href="/admin/profile">Try loading again</a>
          </div>
        )}
        <a className="back-link" href="/admin">
          ← Back to dashboard
        </a>
      </section>
    </main>
  );
}
