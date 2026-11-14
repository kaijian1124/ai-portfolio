import { SiteShell } from "../../components/site-shell";
export default function Privacy() {
  return (
    <SiteShell>
      <section className="public-section">
        <p className="eyebrow">Privacy</p>
        <h1>
          Your conversation<span className="accent">.</span>
        </h1>
        <div className="markdown">
          <p>
            The public portfolio can be browsed without creating an account. The
            AI assistant uses a signed, HttpOnly session cookie to support
            follow-up questions.
          </p>
          <p>
            Questions, answers, and administrator-only retrieval diagnostics are
            stored for up to 30 days. Usage metrics are retained for up to 90
            days. Network addresses are hashed for abuse prevention. Cleanup
            runs with the background worker and may be delayed if that worker is
            disabled.
          </p>
          <p>
            Relevant questions, limited conversation context, and approved
            portfolio evidence are sent to OpenAI to generate answers.
            Provider-side retention is governed by your provider settings and
            terms; it is separate from this application's database retention.
            OpenAI response storage is disabled in the API request.
          </p>
          <p>
            Please avoid sharing sensitive personal information. New
            conversation starts a separate session; it does not immediately
            delete previous records. Feedback is linked to the answer and your
            chat session.
          </p>
          <p>
            Uploaded knowledge documents remain private. Only approved current
            excerpts can be used in public answers. Project images are public
            assets. Resume downloads use short-lived links to the selected
            active PDF.
          </p>
          <p>
            For privacy questions, use the contact information published on the
            About page.
          </p>
        </div>
        <a className="back-link" href="/about">
          Contact information ↗
        </a>
      </section>
    </SiteShell>
  );
}
