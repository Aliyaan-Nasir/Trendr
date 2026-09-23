/** The parts of an event every handler uses for ids and times. */
export interface EventMeta {
  readonly block: { readonly number: number; readonly timestamp: number };
  readonly logIndex: number;
}

/** Id of a row created by one log: "<block>-<logIndex>", unique per chain. */
export const eventId = (event: EventMeta): string => `${event.block.number}-${event.logIndex}`;

export const timestampOf = (event: EventMeta): bigint => BigInt(event.block.timestamp);

/** Field selections shared by registrations: block time, plus the transaction hash where rows link to it. */
export const WITH_TIME = { block: ["timestamp"] } as const;
export const WITH_TX = { block: ["timestamp"], transaction: ["hash"] } as const;
