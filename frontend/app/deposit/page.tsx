import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import DepositPage from "@/features/deposit/DepositPage";

export const metadata: Metadata = {
  title: "Add funds from any chain",
  description: "Deposit from 35 chains into your Trendr account on Monad with Aurora Intents.",
};

export default function Page() {
  return (
    <PageTransition>
      <DepositPage />
    </PageTransition>
  );
}
