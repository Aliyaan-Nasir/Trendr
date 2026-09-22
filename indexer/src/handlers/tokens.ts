import { indexer } from "envio";
import { applyBalanceChange } from "../lib/book";
import { ZERO_ADDRESS } from "../lib/constants";
import { timestampOf, WITH_TIME } from "../lib/events";

// Balances of every UP, DOWN and trend coin holder. Trades and PnL are booked from the protocol
// events; transfers only move balances and holder counts.
indexer.onEvent({ contract: "TrendrToken", event: "Transfer", fields: WITH_TIME }, async ({ event, context }) => {
  const { from, to, value } = event.params;
  if (value === 0n || from === to) return;
  const token = await context.Token.get(event.srcAddress);
  if (!token) return;
  const timestamp = timestampOf(event);

  const supplyDelta = (from === ZERO_ADDRESS ? value : 0n) - (to === ZERO_ADDRESS ? value : 0n);
  if (supplyDelta !== 0n) context.Token.set({ ...token, totalSupply: token.totalSupply + supplyDelta });

  if (from !== ZERO_ADDRESS) await applyBalanceChange(context, token, from, -value, timestamp);
  if (to !== ZERO_ADDRESS) await applyBalanceChange(context, token, to, value, timestamp);
});
