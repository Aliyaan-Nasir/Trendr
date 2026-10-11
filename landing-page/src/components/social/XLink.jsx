import { X_URL } from "@/config/links";

// The X mark, inline so the footer makes no external request. It takes the text color.
export function XIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" className={className}>
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  );
}

// Trendr's X account, opened in a new tab. `className` sizes and colors the link, `iconClassName` the mark.
export default function XLink({ className, iconClassName }) {
  return (
    <a href={X_URL} target="_blank" rel="noopener noreferrer" aria-label="Trendr on X" title="Trendr on X" className={className}>
      <XIcon className={iconClassName} />
    </a>
  );
}
