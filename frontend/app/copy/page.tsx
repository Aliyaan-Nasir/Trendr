import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import CopyPage from "@/features/copy/CopyPage";

export const metadata: Metadata = { title: "Copy trading", description: "Follow a trader's Perpl positions on your own account, scaled to your size and held inside your caps." };

export default function Page() {
  return (
    <PageTransition>
      <CopyPage />
    </PageTransition>
  );
}
