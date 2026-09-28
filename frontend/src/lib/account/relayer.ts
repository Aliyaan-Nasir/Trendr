/** HTTP client for the Trendr relayer, which pays gas for account activation and trades. */
import { retryAfterSec } from "@/lib/rate-limit";

export interface Relayed {
  hash: `0x${string}`;
  status: "success" | "reverted";
  blockNumber: string;
  gasUsed: string;
  gasLimit: string;
}

export interface AccountStatus {
  delegatedTo: `0x${string}` | null;
  active: boolean;
  /** 2 on the current PasskeyAccount; 1 on the replaced version 1, which upgrades with one prompt. */
  version: 1 | 2 | null;
}

export class RelayerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds the relayer asked to wait (Retry-After) before trying again. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export function createRelayerClient(baseUrl: string) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, init);
    } catch {
      throw new RelayerError(0, "unreachable", "the relayer could not be reached");
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new RelayerError(res.status, body.error ?? "unknown", body.message ?? `relayer returned ${res.status}`, retryAfterSec(res.headers.get("retry-after")));
    return body as T;
  }
  const post = <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: toJson(body) });

  return {
    status: (account: string) => request<AccountStatus>(`/v1/accounts/${account}`),
    activate: (body: unknown) => post<Relayed>("/v1/accounts/activate", body),
    upgrade: (body: unknown) => post<Relayed>("/v1/accounts/upgrade", body),
    session: (body: unknown) => post<Relayed>("/v1/session/execute", body),
    owner: (body: unknown) => post<Relayed>("/v1/owner/execute", body),
  };
}

export type RelayerClient = ReturnType<typeof createRelayerClient>;
