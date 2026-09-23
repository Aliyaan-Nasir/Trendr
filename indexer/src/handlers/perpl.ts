import { type Enum, indexer, type PerplAccount, type PerplCursor, type PerplMarket, type PerplPosition } from "envio";
import {
  type Context,
  recordAccountTrade,
  recordClosedTrade,
  recordFees,
  recordMarketVolume,
  recordRealizedPnl,
  updateAccount,
} from "../lib/aggregates";
import { AUSD_DECIMALS, isBotWallet } from "../lib/constants";
import { eventId, type EventMeta, timestampOf, WITH_TIME, WITH_TX } from "../lib/events";
import { perplMarketInfo } from "../lib/rpc";
import { ausd, toDecimal } from "../lib/units";

// Perpl's Exchange serves every account on the chain. Its events carry the account id in the data
// (nothing is indexed), so each handler looks the account up and returns early for anyone who is
// not a Trendr account (a passkey account or a Trendr bot).
//
// TakerOrderFilledV2 names no account. In every match the taker's own position event comes
// immediately before its taker fill, after the makers' fills, so position events of Trendr accounts
// leave a one-row cursor that the next fill reads.

const CURSOR_ID = "cursor";

type Action = Enum<"PerplAction">;
type Meta = EventMeta & { readonly transaction: { readonly hash: string }; readonly srcAddress: string };

const isLongType = (positionType: bigint): boolean => positionType === 0n;
const pointerId = (accountId: string, perpId: bigint): string => `${accountId}-${perpId}`;

async function trendrAccount(context: Context, accountId: bigint): Promise<PerplAccount | undefined> {
  const account = await context.PerplAccount.get(accountId.toString());
  return account?.isTrendr ? account : undefined;
}

async function loadMarket(context: Context, exchange: string, perpId: bigint): Promise<PerplMarket> {
  const existing = await context.PerplMarket.get(perpId.toString());
  if (existing) return existing;
  const info = await context.effect(perplMarketInfo, { exchange, perpId: perpId.toString() });
  const market: PerplMarket = {
    id: perpId.toString(),
    perpId,
    name: info.name,
    symbol: info.symbol,
    priceDecimals: info.priceDecimals,
    lotDecimals: info.lotDecimals,
    trendrVolume: 0n,
    trendrFillCount: 0,
  };
  context.PerplMarket.set(market);
  return market;
}

const price = (market: PerplMarket, pns: bigint) => toDecimal(pns, market.priceDecimals);
const size = (market: PerplMarket, lns: bigint) => toDecimal(lns, market.lotDecimals);

/** Collateral notional of `lot` at `price`, in CNS (AUSD, 6 decimals). */
function notionalCns(market: PerplMarket, pns: bigint, lns: bigint): bigint {
  return (pns * lns * 10n ** BigInt(AUSD_DECIMALS)) / 10n ** BigInt(market.priceDecimals + market.lotDecimals);
}

function setCursor(
  context: Context,
  event: EventMeta,
  account: PerplAccount,
  perpId: bigint,
  position: PerplPosition,
  action: Action,
): void {
  const cursor: PerplCursor = {
    id: CURSOR_ID,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    accountId: account.id,
    perpId: perpId.toString(),
    positionId: position.id,
    action,
    isLong: position.isLong,
  };
  context.PerplCursor.set(cursor);
}

/** Counts a finished position in the owner's track record once its last fee is booked. */
async function finalize(context: Context, position: PerplPosition, timestamp: bigint): Promise<PerplPosition> {
  if (position.finalized || position.status === "OPEN") return position;
  await recordClosedTrade(
    context,
    position.owner_id,
    position.realizedPnlCns,
    timestamp,
    position.status === "LIQUIDATED",
  );
  const next = { ...position, finalized: true };
  context.PerplPosition.set(next);
  return next;
}

async function currentPosition(
  context: Context,
  account: PerplAccount,
  perpId: bigint,
): Promise<PerplPosition | undefined> {
  const pointer = await context.PerplOpenPosition.get(pointerId(account.id, perpId));
  return pointer ? context.PerplPosition.get(pointer.positionId) : undefined;
}

interface Opening {
  isLong: boolean;
  pricePns: bigint;
  lotLns: bigint;
  depositCns: bigint;
  leverageHdths: bigint;
}

async function openPosition(
  context: Context,
  event: Meta,
  account: PerplAccount,
  perpId: bigint,
  o: Opening,
): Promise<PerplPosition> {
  const timestamp = timestampOf(event);
  const market = await loadMarket(context, event.srcAddress, perpId);
  // Perpl keeps one position per account and market, so an opening ends whatever came before.
  let previous = await currentPosition(context, account, perpId);
  if (previous?.status === "OPEN") previous = await closePosition(context, event, previous, "CLOSED", undefined);
  if (previous) await finalize(context, previous, timestamp);
  const owner = account.owner_id ?? account.ownerAddress;
  const position: PerplPosition = {
    id: `${account.id}-${perpId}-${eventId(event)}`,
    account_id: account.id,
    owner_id: owner,
    market_id: market.id,
    isLong: o.isLong,
    status: "OPEN",
    entryPricePns: o.pricePns,
    entryPrice: price(market, o.pricePns),
    lotLns: o.lotLns,
    size: size(market, o.lotLns),
    maxLotLns: o.lotLns,
    depositCns: o.depositCns,
    leverageHdths: o.leverageHdths,
    deltaPnlCns: 0n,
    fundingCns: 0n,
    feesCns: 0n,
    realizedPnlCns: 0n,
    realizedPnlAusd: ausd(0n),
    closePricePns: undefined,
    openedAt: timestamp,
    openedBlock: event.block.number,
    openTxHash: event.transaction.hash,
    closedAt: undefined,
    closedBlock: undefined,
    closeTxHash: undefined,
    finalized: false,
  };
  context.PerplPosition.set(position);
  context.PerplOpenPosition.set({ id: pointerId(account.id, perpId), positionId: position.id });
  await updateAccount(context, owner, timestamp, (a) => ({ perplOpenPositionCount: a.perplOpenPositionCount + 1 }));
  return position;
}

/** Books realized PnL (deltaPnl + funding, funding positive when received) on a position. */
async function realize(
  context: Context,
  account: PerplAccount,
  position: PerplPosition,
  deltaPnl: bigint,
  funding: bigint,
  timestamp: bigint,
): Promise<PerplPosition> {
  const realizedPnlCns = position.realizedPnlCns + deltaPnl + funding;
  const next = {
    ...position,
    deltaPnlCns: position.deltaPnlCns + deltaPnl,
    fundingCns: position.fundingCns + funding,
    realizedPnlCns,
    realizedPnlAusd: ausd(realizedPnlCns),
  };
  context.PerplPosition.set(next);
  const latest = (await context.PerplAccount.get(account.id)) ?? account;
  context.PerplAccount.set({ ...latest, realizedPnl: latest.realizedPnl + deltaPnl + funding });
  await recordRealizedPnl(context, {
    account: position.owner_id,
    product: "perpl",
    pnl: deltaPnl + funding,
    timestamp,
  });
  return next;
}

async function closePosition(
  context: Context,
  event: Meta,
  position: PerplPosition,
  status: "CLOSED" | "LIQUIDATED",
  closePricePns: bigint | undefined,
): Promise<PerplPosition> {
  const timestamp = timestampOf(event);
  const next: PerplPosition = {
    ...position,
    status,
    lotLns: 0n,
    size: toDecimal(0n, 0),
    closePricePns,
    closedAt: timestamp,
    closedBlock: event.block.number,
    closeTxHash: event.transaction.hash,
  };
  context.PerplPosition.set(next);
  await updateAccount(context, position.owner_id, timestamp, (a) => ({
    perplOpenPositionCount: a.perplOpenPositionCount - 1,
  }));
  return next;
}

// ---------------------------------------------------------------------------------------------
// Accounts and collateral
// ---------------------------------------------------------------------------------------------

indexer.onEvent(
  { contract: "PerplExchange", event: "AccountCreated", fields: WITH_TIME },
  async ({ event, context }) => {
    const { account: ownerAddress, id } = event.params;
    const timestamp = timestampOf(event);
    const owner = await context.Account.get(ownerAddress);
    const isTrendr = owner?.isPasskey === true || isBotWallet(context.chain.id, ownerAddress);
    context.PerplAccount.set({
      id: id.toString(),
      accountId: id,
      ownerAddress,
      owner_id: isTrendr ? ownerAddress : undefined,
      isTrendr,
      createdAt: timestamp,
      createdBlock: event.block.number,
      balanceCns: 0n,
      deposited: 0n,
      withdrawn: 0n,
      orderForwarding: false,
      volume: 0n,
      feesPaid: 0n,
      realizedPnl: 0n,
      fillCount: 0,
    });
    if (isTrendr) await updateAccount(context, ownerAddress, timestamp, () => ({ perplAccount_id: id.toString() }));
  },
);

indexer.onEvent(
  { contract: "PerplExchange", event: "CollateralDeposit", fields: WITH_TIME },
  async ({ event, context }) => {
    const { accountId, amountCNS, balanceCNS } = event.params;
    const account = await trendrAccount(context, accountId);
    if (!account) return;
    context.PerplAccount.set({ ...account, deposited: account.deposited + amountCNS, balanceCns: balanceCNS });
    await updateAccount(context, account.ownerAddress, timestampOf(event), () => ({ perplCollateral: balanceCNS }));
  },
);

indexer.onEvent(
  { contract: "PerplExchange", event: "CollateralWithdrawal", fields: WITH_TIME },
  async ({ event, context }) => {
    const { accountId, amountCNS, balanceCNS } = event.params;
    const account = await trendrAccount(context, accountId);
    if (!account) return;
    context.PerplAccount.set({ ...account, withdrawn: account.withdrawn + amountCNS, balanceCns: balanceCNS });
    await updateAccount(context, account.ownerAddress, timestampOf(event), () => ({ perplCollateral: balanceCNS }));
  },
);

indexer.onEvent(
  { contract: "PerplExchange", event: "OrderForwardingUpdated", fields: WITH_TIME },
  async ({ event, context }) => {
    const account = await trendrAccount(context, event.params.accountId);
    if (account) context.PerplAccount.set({ ...account, orderForwarding: event.params.allowed });
  },
);

// ---------------------------------------------------------------------------------------------
// Position lifecycle
// ---------------------------------------------------------------------------------------------

indexer.onEvent(
  { contract: "PerplExchange", event: "PositionOpenedV2", fields: WITH_TX },
  async ({ event, context }) => {
    const p = event.params;
    const account = await trendrAccount(context, p.accountId);
    if (!account) return;
    const position = await openPosition(context, event, account, p.perpId, {
      isLong: isLongType(p.positionType),
      pricePns: p.pricePNS,
      lotLns: p.lotLNS,
      depositCns: p.depositCNS,
      leverageHdths: p.leverageHdths,
    });
    setCursor(context, event, account, p.perpId, position, "OPEN");
  },
);

indexer.onEvent(
  { contract: "PerplExchange", event: "PositionIncreasedV2", fields: WITH_TX },
  async ({ event, context }) => {
    const p = event.params;
    const account = await trendrAccount(context, p.accountId);
    if (!account) return;
    const opening = {
      isLong: isLongType(p.positionType),
      pricePns: p.pricePNS,
      lotLns: p.endLotLNS,
      depositCns: p.endDepositCNS,
      leverageHdths: p.leverageHdths,
    };
    let position = await currentPosition(context, account, p.perpId);
    if (!position || position.status !== "OPEN") {
      // A position opened before the start block: track it from here.
      position = await openPosition(context, event, account, p.perpId, opening);
    } else {
      const market = await loadMarket(context, event.srcAddress, p.perpId);
      // pricePNS is the position's entry price after the increase (the size-weighted average of its
      // fills, as live Testnet events show), not the price of this fill.
      position = {
        ...position,
        entryPricePns: p.pricePNS,
        entryPrice: price(market, p.pricePNS),
        lotLns: p.endLotLNS,
        size: size(market, p.endLotLNS),
        maxLotLns: p.endLotLNS > position.maxLotLns ? p.endLotLNS : position.maxLotLns,
        depositCns: p.endDepositCNS,
        leverageHdths: p.leverageHdths,
      };
      context.PerplPosition.set(position);
    }
    setCursor(context, event, account, p.perpId, position, "INCREASE");
  },
);

indexer.onEvent(
  { contract: "PerplExchange", event: "PositionDecreased", fields: WITH_TX },
  async ({ event, context }) => {
    const p = event.params;
    const account = await trendrAccount(context, p.accountId);
    if (!account) return;
    let position = await currentPosition(context, account, p.perpId);
    if (!position || position.status !== "OPEN") return;
    const market = await loadMarket(context, event.srcAddress, p.perpId);
    position = await realize(context, account, position, p.deltaPnlCNS, p.fundingCNS, timestampOf(event));
    position = { ...position, lotLns: p.endLotLNS, size: size(market, p.endLotLNS), depositCns: p.endDepositCNS };
    context.PerplPosition.set(position);
    if (p.endLotLNS === 0n) position = await closePosition(context, event, position, "CLOSED", undefined);
    setCursor(context, event, account, p.perpId, position, p.endLotLNS === 0n ? "CLOSE" : "DECREASE");
  },
);

indexer.onEvent({ contract: "PerplExchange", event: "PositionClosed", fields: WITH_TX }, async ({ event, context }) => {
  const p = event.params;
  const account = await trendrAccount(context, p.accountId);
  if (!account) return;
  let position = await currentPosition(context, account, p.perpId);
  if (!position || position.status !== "OPEN") return;
  position = await realize(context, account, position, p.deltaPnlCNS, p.fundingCNS, timestampOf(event));
  position = await closePosition(context, event, position, "CLOSED", p.pricePNS);
  setCursor(context, event, account, p.perpId, position, "CLOSE");
});

indexer.onEvent(
  { contract: "PerplExchange", event: "PositionInverted", fields: WITH_TX },
  async ({ event, context }) => {
    const p = event.params;
    const account = await trendrAccount(context, p.accountId);
    if (!account) return;
    const timestamp = timestampOf(event);
    let previous = await currentPosition(context, account, p.perpId);
    if (previous && previous.status === "OPEN") {
      previous = await realize(context, account, previous, p.deltaPnlCNS, p.fundingCNS, timestamp);
      previous = await closePosition(context, event, previous, "CLOSED", p.pricePNS);
    }
    // The flip's fill fee follows and is booked on the new position.
    const position = await openPosition(context, event, account, p.perpId, {
      isLong: isLongType(p.positionType),
      pricePns: p.pricePNS,
      lotLns: p.endLotLNS,
      depositCns: p.endDepositCNS,
      leverageHdths: p.leverageHdths,
    });
    setCursor(context, event, account, p.perpId, position, "INVERT");
  },
);

indexer.onEvent(
  { contract: "PerplExchange", event: "PositionLiquidated", fields: WITH_TX },
  async ({ event, context }) => {
    const p = event.params;
    const account = await trendrAccount(context, p.posAccountId);
    if (!account) return;
    const timestamp = timestampOf(event);
    let position = await currentPosition(context, account, p.perpId);
    if (!position || position.status !== "OPEN") return;
    position = await realize(context, account, position, p.deltaPnlCNS, p.fundingCNS, timestamp);
    if (p.liqLotLNS >= p.posLotLNS) {
      position = await closePosition(context, event, position, "LIQUIDATED", p.liqPricePNS);
      position = await finalize(context, position, timestamp);
    } else {
      const market = await loadMarket(context, event.srcAddress, p.perpId);
      const lotLns = p.posLotLNS - p.liqLotLNS;
      position = { ...position, lotLns, size: size(market, lotLns) };
      context.PerplPosition.set(position);
    }
    setCursor(context, event, account, p.perpId, position, "LIQUIDATE");
  },
);

indexer.onEvent(
  { contract: "PerplExchange", event: "PositionDeleveragedV2", fields: WITH_TX },
  async ({ event, context }) => {
    const p = event.params;
    const account = await trendrAccount(context, p.accountId);
    if (!account) return;
    let position = await currentPosition(context, account, p.perpId);
    if (!position || position.status !== "OPEN") return;
    const market = await loadMarket(context, event.srcAddress, p.perpId);
    position = await realize(context, account, position, p.deltaPnlCNS, p.fundingCNS, timestampOf(event));
    position = { ...position, lotLns: p.endLotLNS, size: size(market, p.endLotLNS), depositCns: p.endDepositCNS };
    context.PerplPosition.set(position);
    if (p.endLotLNS === 0n) {
      position = await closePosition(context, event, position, "CLOSED", p.deleveragePricePNS);
      position = await finalize(context, position, timestampOf(event));
    }
    setCursor(context, event, account, p.perpId, position, "DELEVERAGE");
  },
);

// ---------------------------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------------------------

interface FillInput {
  role: "MAKER" | "TAKER";
  account: PerplAccount;
  perpId: bigint;
  orderId: bigint | undefined;
  pricePns: bigint;
  lotLns: bigint;
  feeCns: bigint;
  builderFeeCns: bigint;
  amountCns: bigint;
  balanceCns: bigint;
  cursor: PerplCursor | undefined;
}

async function recordFill(context: Context, event: Meta, f: FillInput): Promise<void> {
  const timestamp = timestampOf(event);
  const market = await loadMarket(context, event.srcAddress, f.perpId);
  const owner = f.account.owner_id ?? f.account.ownerAddress;
  const notional = notionalCns(market, f.pricePns, f.lotLns);
  let position = f.cursor ? await context.PerplPosition.get(f.cursor.positionId) : undefined;

  context.PerplFill.set({
    id: eventId(event),
    account_id: f.account.id,
    owner_id: owner,
    market_id: market.id,
    position_id: position?.id,
    role: f.role,
    action: f.cursor?.action,
    isLong: f.cursor?.isLong,
    orderId: f.orderId,
    pricePns: f.pricePns,
    price: price(market, f.pricePns),
    lotLns: f.lotLns,
    size: size(market, f.lotLns),
    notionalCns: notional,
    notionalAusd: ausd(notional),
    feeCns: f.feeCns,
    builderFeeCns: f.builderFeeCns,
    amountCns: f.amountCns,
    balanceCns: f.balanceCns,
    blockNumber: event.block.number,
    timestamp,
    txHash: event.transaction.hash,
  });
  const account = (await context.PerplAccount.get(f.account.id)) ?? f.account;
  context.PerplAccount.set({
    ...account,
    volume: account.volume + notional,
    feesPaid: account.feesPaid + f.feeCns,
    realizedPnl: account.realizedPnl - f.feeCns,
    fillCount: account.fillCount + 1,
    balanceCns: f.balanceCns,
  });
  context.PerplMarket.set({
    ...market,
    trendrVolume: market.trendrVolume + notional,
    trendrFillCount: market.trendrFillCount + 1,
  });
  await updateAccount(context, owner, timestamp, () => ({ perplCollateral: f.balanceCns }));
  await recordMarketVolume(context, { product: "perpl", amount: notional, timestamp });
  await recordAccountTrade(context, { account: owner, product: "perpl", amount: notional, timestamp });
  await recordFees(context, owner, f.feeCns, timestamp);
  // Trading fees are part of realized PnL.
  await recordRealizedPnl(context, { account: owner, product: "perpl", pnl: -f.feeCns, timestamp });

  if (position) {
    const realizedPnlCns = position.realizedPnlCns - f.feeCns;
    position = {
      ...position,
      feesCns: position.feesCns + f.feeCns,
      realizedPnlCns,
      realizedPnlAusd: ausd(realizedPnlCns),
    };
    context.PerplPosition.set(position);
    // The closing fill carries the last fee: the round trip is complete now.
    await finalize(context, position, timestamp);
  }
}

indexer.onEvent(
  { contract: "PerplExchange", event: "MakerOrderFilledV2", fields: WITH_TX },
  async ({ event, context }) => {
    const p = event.params;
    const account = await trendrAccount(context, p.accountId);
    if (!account) return;
    // A maker's position event comes just before its fill (an order removal may sit in between).
    const cursor = await context.PerplCursor.get(CURSOR_ID);
    const matches =
      cursor !== undefined &&
      cursor.blockNumber === event.block.number &&
      cursor.accountId === account.id &&
      cursor.perpId === p.perpId.toString() &&
      event.logIndex - cursor.logIndex <= 2;
    await recordFill(context, event, {
      role: "MAKER",
      account,
      perpId: p.perpId,
      orderId: p.orderId,
      pricePns: p.pricePNS,
      lotLns: p.lotLNS,
      feeCns: p.feeCNS,
      builderFeeCns: p.builderFeeCNS,
      amountCns: p.amountCNS,
      balanceCns: p.balanceCNS,
      cursor: matches ? cursor : undefined,
    });
  },
);

indexer.onEvent(
  { contract: "PerplExchange", event: "TakerOrderFilledV2", fields: WITH_TX },
  async ({ event, context }) => {
    const cursor = await context.PerplCursor.get(CURSOR_ID);
    if (!cursor || cursor.blockNumber !== event.block.number || cursor.logIndex !== event.logIndex - 1) return;
    const account = await trendrAccount(context, BigInt(cursor.accountId));
    if (!account) return;
    const p = event.params;
    await recordFill(context, event, {
      role: "TAKER",
      account,
      perpId: BigInt(cursor.perpId),
      orderId: undefined,
      pricePns: p.entryPricePNS,
      lotLns: p.lotLNS,
      feeCns: p.feeCNS,
      builderFeeCns: p.builderFeeCNS,
      amountCns: p.amountCNS,
      balanceCns: p.balanceCNS,
      cursor,
    });
  },
);
