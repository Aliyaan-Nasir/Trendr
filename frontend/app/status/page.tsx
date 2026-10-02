import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import Status from "@/features/status/Status";

export const metadata: Metadata = {
  title: "Status",
  description: "Live health of Trendr: the Chainlink CRE attention oracle, the keeper, the market maker, the relayer, Autopilot and Monad itself.",
};

export default function Page() {
  return (
    <PageTransition>
      <Status />
    </PageTransition>
  );
}
