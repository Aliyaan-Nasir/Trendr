import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import CallerProfile from "@/features/callers/CallerProfile";

const label = (id: string) => (/^0x[0-9a-fA-F]{40}$/.test(id) ? `${id.slice(0, 6)}...${id.slice(-4)}` : `@${id}`);

export async function generateMetadata(props: PageProps<"/c/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  return { title: label(decodeURIComponent(id)), description: "A Trendr caller's track record: calls on trends' attention, resolved by the oracle, and their Autopilot trading record." };
}

/** A caller by identity address or handle, or a trading account's record. */
export default async function Page(props: PageProps<"/c/[id]">) {
  const { id } = await props.params;
  return (
    <PageTransition>
      <CallerProfile id={decodeURIComponent(id).toLowerCase()} />
    </PageTransition>
  );
}
