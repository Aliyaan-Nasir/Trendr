"use client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError } from "@/src/lib/api";
import { signOut, useSession } from "@/src/lib/auth/session";
import { sameAddress, useWallet } from "@/src/lib/wallet/injected";
import AuthGate from "./AuthGate";
import Header from "./Header";
import { ToastProvider } from "./ui/Toasts";

/** Client errors (4xx) will not change on a retry; network failures and 5xx might. */
const retry = (failures: number, error: unknown) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2;

/** Drops cached admin data on sign-out, and the session when the wallet switches accounts. */
function SessionWatch() {
  const queryClient = useQueryClient();
  const { session } = useSession();
  const wallet = useWallet();
  const signedIn = session !== null;

  useEffect(() => {
    if (!signedIn) queryClient.removeQueries({ queryKey: ["admin"] });
  }, [signedIn, queryClient]);

  useEffect(() => {
    if (session && wallet.address && !sameAddress(wallet.address, session.address)) {
      void signOut(`Your wallet switched to ${wallet.address}. Sign in again to use it.`);
    }
  }, [session, wallet.address]);

  return null;
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 10_000, retry, refetchOnWindowFocus: true }, mutations: { retry: false } },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SessionWatch />
        <Header />
        <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 sm:px-6 sm:pt-8">
          <AuthGate>{children}</AuthGate>
        </main>
      </ToastProvider>
    </QueryClientProvider>
  );
}
