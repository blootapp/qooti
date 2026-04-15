import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function LegalMarkdownBody({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h1 className="mb-2 text-3xl font-semibold tracking-tight text-[var(--white)]">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-3 mt-10 border-b border-[var(--border)] pb-2 text-xl font-semibold tracking-tight text-[var(--white)] first:mt-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-2 mt-6 text-lg font-medium text-[var(--white)]">{children}</h3>
        ),
        p: ({ children }) => (
          <p className="mb-4 text-[15px] font-light leading-relaxed text-[var(--muted)]">{children}</p>
        ),
        strong: ({ children }) => <strong className="font-semibold text-[var(--white)]">{children}</strong>,
        em: ({ children }) => <em className="italic text-[var(--muted)]">{children}</em>,
        ul: ({ children }) => (
          <ul className="mb-4 list-disc space-y-2 pl-6 text-[15px] font-light leading-relaxed text-[color:color-mix(in_oklch,var(--white)_82%,transparent)]">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-[15px] font-light leading-relaxed text-[color:color-mix(in_oklch,var(--white)_82%,transparent)]">
            {children}
          </ol>
        ),
        li: ({ children }) => <li className="marker:text-[var(--muted2)]">{children}</li>,
        hr: () => <hr className="my-10 border-[var(--border)]" />,
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-[var(--accent)] underline decoration-[color-mix(in_oklch,var(--accent)_50%,transparent)] underline-offset-2 transition hover:opacity-90"
            target={href?.startsWith("http") ? "_blank" : undefined}
            rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
          >
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="mb-6 overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="w-full min-w-[280px] border-collapse text-left text-[14px]">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-[var(--surface2)]">{children}</thead>,
        th: ({ children }) => (
          <th className="border-b border-[var(--border)] px-4 py-3 font-medium text-[var(--white)]">{children}</th>
        ),
        td: ({ children }) => (
          <td className="border-b border-[var(--border)] px-4 py-2.5 text-[var(--white)]">{children}</td>
        ),
        tbody: ({ children }) => <tbody>{children}</tbody>,
        blockquote: ({ children }) => (
          <blockquote className="mb-4 border-l-2 border-[var(--accent)] pl-4 text-[var(--muted)]">{children}</blockquote>
        ),
        code: ({ children }) => (
          <code className="rounded bg-[var(--surface2)] px-1.5 py-0.5 text-[13px] text-[var(--accent)]">{children}</code>
        ),
      }}
    >
      {source}
    </ReactMarkdown>
  );
}
