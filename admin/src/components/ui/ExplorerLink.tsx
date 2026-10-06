import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A link to Monadscan. With children (an address, a hash) they are the label and the icon marks
 * it external; without, it reads "View on Monadscan", or "Monadscan" where room is short.
 */
export function ExplorerLink({ href, short = false, className = "", children, testId }: { href: string; short?: boolean; className?: string; children?: ReactNode; testId?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={children ? "View on Monadscan" : undefined}
      data-testid={testId}
      className={`inline-flex min-w-0 items-center gap-1 rounded text-muted transition-colors hover:text-fg ${className}`}
    >
      {children ?? <span>{short ? "Monadscan" : "View on Monadscan"}</span>}
      <ExternalLink size={12} className="shrink-0" aria-hidden />
    </a>
  );
}
