import { indexer } from "envio";
import { loadAccount, updateAccount, updateProtocol } from "../lib/aggregates";
import { isPasskeyImplementation } from "../lib/constants";
import { timestampOf, WITH_TIME } from "../lib/events";
import { delegateOf } from "../lib/rpc";

// PasskeyAccount is EIP-7702 delegated code: a user's EOA runs it, so the event comes from the
// user's own address. Matching it by signature on every address finds every Trendr account, but
// any contract (or an EOA delegated to other code) can emit the same event, so an address counts
// only if it ran Trendr's PasskeyAccount at that block.
indexer.onEvent(
  { contract: "PasskeyAccount", event: "Initialized", wildcard: true, fields: WITH_TIME },
  async ({ event, context }) => {
    const address = event.srcAddress;
    const { delegate } = await context.effect(delegateOf, { address, blockNumber: event.block.number });
    if (!delegate || !isPasskeyImplementation(context.chain.id, delegate)) return;
    const timestamp = timestampOf(event);
    const [account, perplAccounts] = await Promise.all([
      loadAccount(context, address, timestamp),
      context.PerplAccount.getWhere({ ownerAddress: { _eq: address } }),
    ]);
    if (account.isPasskey) return;
    const perplAccount = perplAccounts[0];
    await updateAccount(context, address, timestamp, (a) => ({
      kind: a.kind === "PROTOCOL" ? a.kind : "PASSKEY",
      isPasskey: true,
      passkeyOwnerX: event.params.ownerX,
      passkeyOwnerY: event.params.ownerY,
      passkeyInitializedAt: timestamp,
      perplAccount_id: perplAccount?.id ?? a.perplAccount_id,
    }));
    // A Perpl account the address opened before delegating becomes a Trendr account now.
    for (const p of perplAccounts) context.PerplAccount.set({ ...p, isTrendr: true, owner_id: address });
    await updateProtocol(context, timestamp, (p) => ({ passkeyAccountCount: p.passkeyAccountCount + 1 }));
  },
);
