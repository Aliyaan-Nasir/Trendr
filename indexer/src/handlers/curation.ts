import { type CurationEarnings, type Enum, indexer } from "envio";
import { type Context, updateAccount, updateProtocol, updateTrendDay, updateTrendStats } from "../lib/aggregates";
import { isContract } from "../lib/constants";
import { eventId, timestampOf, WITH_TX } from "../lib/events";
import { ausd, ZERO_DECIMAL } from "../lib/units";

function sourceProduct(context: Context, source: string): Enum<"CurationSource"> {
  if (isContract(context.chain.id, "AttentionPerp", source)) return "PERP";
  if (isContract(context.chain.id, "BondingCurve", source)) return "CURVE";
  return "OTHER";
}

async function loadEarnings(context: Context, account: string): Promise<CurationEarnings> {
  return context.CurationEarnings.getOrCreate({
    id: account,
    account_id: account,
    earned: 0n,
    earnedAusd: ZERO_DECIMAL,
    claimed: 0n,
    claimable: 0n,
    accrualCount: 0,
    trendCount: 0,
    lastAccruedAt: undefined,
  });
}

indexer.onEvent({ contract: "CurationFees", event: "Accrued", fields: WITH_TX }, async ({ event, context }) => {
  const { trendId, surfacer, source, amount } = event.params;
  const timestamp = timestampOf(event);
  context.CurationAccrual.set({
    id: eventId(event),
    trend_id: trendId,
    surfacer_id: surfacer,
    source,
    sourceProduct: sourceProduct(context, source),
    amount,
    amountAusd: ausd(amount),
    blockNumber: event.block.number,
    timestamp,
    txHash: event.transaction.hash,
  });

  const perTrend = await context.TrendCuration.getOrCreate({
    id: `${trendId}-${surfacer}`,
    trend_id: trendId,
    account_id: surfacer,
    earned: 0n,
    accrualCount: 0,
  });
  context.TrendCuration.set({ ...perTrend, earned: perTrend.earned + amount, accrualCount: perTrend.accrualCount + 1 });

  const earnings = await loadEarnings(context, surfacer);
  const earned = earnings.earned + amount;
  context.CurationEarnings.set({
    ...earnings,
    earned,
    earnedAusd: ausd(earned),
    claimable: earnings.claimable + amount,
    accrualCount: earnings.accrualCount + 1,
    trendCount: earnings.trendCount + (perTrend.accrualCount === 0 ? 1 : 0),
    lastAccruedAt: timestamp,
  });

  await updateAccount(context, surfacer, timestamp, (a) => ({ curationClaimable: a.curationClaimable + amount }));
  await updateTrendStats(context, trendId, timestamp, (s) => {
    const curationEarned = s.curationEarned + amount;
    return { curationEarned, curationEarnedAusd: ausd(curationEarned) };
  });
  await updateTrendDay(context, trendId, timestamp, (d) => ({ curationEarned: d.curationEarned + amount }));
  await updateProtocol(context, timestamp, (p) => ({ curationAccrued: p.curationAccrued + amount }));
});

indexer.onEvent({ contract: "CurationFees", event: "Claimed", fields: WITH_TX }, async ({ event, context }) => {
  const { account, to, amount } = event.params;
  const timestamp = timestampOf(event);
  const earnings = await loadEarnings(context, account);
  context.CurationEarnings.set({
    ...earnings,
    claimed: earnings.claimed + amount,
    claimable: earnings.claimable - amount,
  });
  context.CurationClaim.set({
    id: eventId(event),
    earnings_id: account,
    account_id: account,
    recipient: to,
    amount,
    blockNumber: event.block.number,
    timestamp,
    txHash: event.transaction.hash,
  });
  await updateAccount(context, account, timestamp, (a) => ({ curationClaimable: a.curationClaimable - amount }));
  await updateProtocol(context, timestamp, (p) => ({ curationClaimed: p.curationClaimed + amount }));
});
