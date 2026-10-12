import Link from "next/link";
import LegalPage, { Contact, Table } from "@/components/legal/LegalPage";
import { legalMetadata } from "@/config/legal";

export const metadata = legalMetadata({
  path: "/cookies",
  title: "Cookie policy",
  description:
    "Trendr sets no cookies and runs no analytics. This page lists the browser storage the app uses to work.",
});

const sections = [
  {
    id: "no-cookies",
    title: "No cookies, no trackers",
    body: (
      <>
        <p>
          The website at trendr.bid and the app at app.trendr.bid <strong>set no cookies</strong>. They run no
          analytics, advertising or social-media trackers, and they do not load third-party scripts that could set
          their own. That is why you will not see a cookie banner here.
        </p>
        <p>
          If we ever add analytics or anything else that is not strictly necessary, we will update this page first
          and ask for your consent where the law requires it.
        </p>
      </>
    ),
  },
  {
    id: "storage",
    title: "Browser storage the app uses",
    body: (
      <>
        <p>
          The app keeps a few items in your browser&apos;s own storage so that it works. They stay on your device,
          are only readable by app.trendr.bid, and are strictly necessary for the features you use:
        </p>
        <Table
          head={["Name", "Where", "What it is for", "How long"]}
          rows={[
            [<code key="a">trendr-account</code>, "IndexedDB", "Your trading session key, encrypted under a key the browser cannot export, so you trade without a passkey prompt each time.", "Until it expires or you clear site data"],
            [<code key="b">trendr-private</code>, "IndexedDB", "The keys that open your vault and sign your posts and Perpl requests, encrypted the same way.", "Until you clear site data"],
            [<code key="c">trendr.backend-token</code>, "Session storage", "Your sign-in token for the Trendr backend.", "Until you close the tab"],
            [<code key="d">trendr.pending-activation</code>, "Local storage", "A new account's public key while its setup finishes.", "Until setup completes"],
            [<code key="e">trendr.theme</code>, "Local storage", "Light or dark theme, if you picked one.", "Until you change it or clear site data"],
            [<code key="f">trendr.push.topics</code>, "Local storage", "Which notification topics you turned on.", "Until you change them or clear site data"],
            [<code key="g">trendr.portfolio.series:&lt;account&gt;</code>, "Local storage", "A short list of outcome series you traded, so your portfolio finds them quickly.", "Until you clear site data"],
            [<code key="h">trendr.waitlist</code>, "Local storage", "The email you joined the Mainnet waitlist with, and whether you closed its banner, so the app shows that you joined.", "Until you clear site data"],
          ]}
        />
        <p>
          Your passkey itself is kept by your device or password manager, not by Trendr. The marketing website at
          trendr.bid stores nothing in your browser.
        </p>
      </>
    ),
  },
  {
    id: "control",
    title: "How to remove it",
    body: (
      <p>
        You can clear all of it at any time in your browser&apos;s settings (site data for app.trendr.bid). You will
        then need your passkey to sign in again, and nothing else is lost: your account and assets live on chain,
        and your vault is stored encrypted by the backend. More about what we store is in the{" "}
        <Link href="/privacy">privacy policy</Link>.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about this policy: <Contact />.
      </p>
    ),
  },
];

export default function CookiesPage() {
  return (
    <LegalPage
      path="/cookies"
      title="Cookie policy"
      intro="Short, because there is not much to say: Trendr uses no cookies."
      sections={sections}
    />
  );
}
