import { AdminNav } from "../../components/admin-nav";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAdminAccess } from "../../lib/admin-session";
import { checkBackendAdmin } from "../../lib/backend-admin";
import { signOutAction } from "./actions";

export const dynamic = "force-dynamic";

async function BackendAuthorization({
  token,
  userId,
}: {
  token: string;
  userId: string;
}) {
  const status = await checkBackendAdmin(token, userId);
  const text = {
    verified: "Backend permission verified",
    denied:
      "Backend permission denied. Check the server administrator configuration.",
    unavailable:
      "Backend is not ready. Start the API or allow it to wake up, then refresh.",
  };
  return (
    <p role="status" className="content-message">
      {text[status]}
    </p>
  );
}

export default async function AdminPage() {
  const access = await getAdminAccess();
  if (access.state === "unauthenticated") redirect("/login");
  if (access.state !== "authorized") {
    return (
      <main>
        <section className="auth-panel">
          <p className="eyebrow">Private workspace</p>
          <h1>
            {access.state === "forbidden"
              ? "Access denied."
              : "Sign-in unavailable."}
          </h1>
          <p className="lead">
            {access.state === "forbidden"
              ? "This account does not have administrator access."
              : "We could not verify your account. Please try again."}
          </p>
          <form action={signOutAction}>
            <button>Return to sign in</button>
          </form>
        </section>
      </main>
    );
  }
  return (
    <main>
      <header>
        <a className="wordmark" href="/">
          Portfolio<span className="accent">.</span>
        </a>
        <form action={signOutAction}>
          <button>Sign out</button>
        </form>
      </header>
      <AdminNav />
      <section className="admin-panel">
        <p className="eyebrow">Private workspace</p>
        <h1>
          Admin dashboard<span className="accent">.</span>
        </h1>
        <p className="lead">
          Manage your published portfolio, private files, and AI knowledge base.
        </p>
        <Suspense
          fallback={
            <p className="content-message" role="status">
              Verifying backend permission…
            </p>
          }
        >
          <BackendAuthorization
            token={access.accessToken}
            userId={access.userId}
          />
        </Suspense>
        <div className="empty-state">
          <span className="small-label">Content management</span>
          <p>
            <a className="back-link" href="/admin/profile">
              Edit profile ↗
            </a>
          </p>
          <p>
            Save drafts, publish current information, and withdraw outdated
            content. Use the navigation to manage projects, skills, experience,
            education, Resume versions, and knowledge documents.
          </p>
        </div>
        <a className="back-link" href="/">
          ← View portfolio
        </a>
      </section>
    </main>
  );
}
