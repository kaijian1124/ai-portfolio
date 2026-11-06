import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeExternalUrl } from "../lib/public-links";
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            const internal =
              (href?.startsWith("/") && !href.startsWith("//")) ||
              href?.startsWith("#");
            const safe = internal ? href : safeExternalUrl(href ?? null);
            return safe ? (
              <a
                href={safe}
                target={internal ? undefined : "_blank"}
                rel={internal ? undefined : "noopener noreferrer"}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          img: () => null,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
