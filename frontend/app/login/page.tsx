import { redirect } from "next/navigation";
import { LoginForm } from "../../components/login-form";
import { getAdminAccess } from "../../lib/admin-session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const access = await getAdminAccess();
  if (access.state === "authorized") redirect("/admin");
  return (
    <main id="main-content" className="auth-main">
      <header>
        <a className="wordmark" href="/">
          Portfolio<span className="accent">.</span>
        </a>
        <span className="badge">Admin</span>
      </header>
      <section className="auth-panel" aria-labelledby="login-heading">
        <p className="eyebrow">Private workspace</p>
        <h1 id="login-heading">
          Welcome back<span className="accent">.</span>
        </h1>
        <p className="lead">Sign in to your administrator account.</p>
        <LoginForm />
        <a className="back-link" href="/">
          ← Back to portfolio
        </a>
      </section>
    </main>
  );
}
