import { iKuruOrderBookAbi } from "@trendr/contracts";
import { type Address, decodeAbiParameters, encodeFunctionData, type Hex, isAddressEqual, keccak256, type Log, toBytes } from "viem";
import type { Level } from "./book";

export const ORDER_CREATED = keccak256(toBytes("OrderCreated(uint40,address,uint96,uint32,bool)"));

export interface PlacedOrder {
  id: number;
  owner: Address;
  size: bigint;
  price: number;
  isBuy: boolean;
}

/**
 * Orders created in a receipt by `market`. Kuru's source declares the event without indexed
 * fields and its documentation with the id and owner indexed, so both layouts are read.
 */
export function placedOrders(logs: readonly Log[], market: Address): PlacedOrder[] {
  const out: PlacedOrder[] = [];
  for (const log of logs) {
    if (!isAddressEqual(log.address, market) || log.topics[0] !== ORDER_CREATED) continue;
    if (log.topics.length === 1) {
      const [id, owner, size, price, isBuy] = decodeAbiParameters(
        [{ type: "uint40" }, { type: "address" }, { type: "uint96" }, { type: "uint32" }, { type: "bool" }],
        log.data,
      );
      out.push({ id: Number(id), owner, size, price: Number(price), isBuy });
    } else if (log.topics.length === 3) {
      const [size, price, isBuy] = decodeAbiParameters([{ type: "uint96" }, { type: "uint32" }, { type: "bool" }], log.data);
      const id = Number(BigInt(log.topics[1]!));
      const owner = `0x${log.topics[2]!.slice(26)}` as Address;
      out.push({ id, owner, size, price: Number(price), isBuy });
    }
  }
  return out;
}

/** One transaction that cancels `cancelIds` and places the ladder, post-only. */
export function encodeRequote(cancelIds: readonly number[], bids: readonly Level[], asks: readonly Level[]): Hex {
  return encodeFunctionData({
    abi: iKuruOrderBookAbi,
    functionName: "batchUpdate",
    args: [bids.map((l) => l.price), bids.map((l) => l.size), asks.map((l) => l.price), asks.map((l) => l.size), cancelIds, true],
  });
}
