import { SiteShell } from "../../components/site-shell";
import { ChatPanel } from "../../components/chat-panel";
export default function Chat() {
  return (
    <SiteShell>
      <section className="public-section">
        <p className="eyebrow">Portfolio assistant</p>
        <h1>
          Ask AI<span className="accent">.</span>
        </h1>
        <ChatPanel />
      </section>
    </SiteShell>
  );
}
