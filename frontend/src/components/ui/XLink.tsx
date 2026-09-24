import { X_URL } from "@/lib/config";

/** The X mark, inline so it makes no external request. It takes the text color. */
export function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" fill="currentColor" className={className}>
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  );
}

/** Trendr's X account in a new tab, as an icon whose label stays for screen readers and as a tooltip. */
export function XLink({ className, iconClassName, testId }: { className?: string; iconClassName?: string; testId?: string }) {
  return (
    <a href={X_URL} target="_blank" rel="noopener noreferrer" aria-label="Trendr on X" title="Trendr on X" data-testid={testId} className={className}>
      <XIcon className={iconClassName} />
    </a>
  );
}
