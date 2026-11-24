// agent-fun/replay/v2 bot shim for Node 22+: one file, erasable TypeScript, node:readline only, so
// it runs as-is under the grader's `node /bot/main.ts`. Copy it to vendor/makefun-pump.ts in your
// repository and hand runPump your strategy:
//
//   import { runPump } from './vendor/makefun-pump.ts';
//   await runPump({
//     onBatch(state, batch) {            // once per batch: the orders decided on it
//       return [{ side: 'buy', mint, quote_lamports: 100_000_000n, max_slippage_bps: 500 }];
//     },
//   });                                  // optional: onHello(state), onDone(state, done)
//
// The shim owns the wire: one JSON line at a time from stdin, `state` kept current (account,
// positions, every mint's latest bonding-curve reserves from its marks and trade events), exactly one
// reply per batch on stdout echoing its seq, before the next line is read. Amounts may be bigint, u64
// decimal strings or safe integers; client_id is filled in when left out. What the harness would call
// a protocol violation (an unknown key, a malformed mint, amount, bps or client_id, a client_id
// starting with `_`, a reply over MAX_BOT_LINE_BYTES, more orders than hello.caps.max_orders_per_batch)
// throws OrderError here, so a broken bot fails on your machine and not in grading. What the market
// refuses (cash, caps, slippage, a completed coin) is no error: it comes back in a later batch's
// fills as status "rejected" with a reason.
//
// Market model (contracts/protocol.ts, agent-fun/replay/v2): the bot trades pump.fun bonding curves
// for SOL. Orders decided on the batch at slot s fill at slot s + hello.latency_slots against the
// curve's reserves then, minus the protocol + creator curve fees and a flat base + priority tx fee,
// and ~failed_tx_bps of orders fail outright (paying only the tx fee). A buy may spend at most
// caps.max_order_bps_of_real_reserve of the mint's real SOL reserve at decision time, summed over the
// buys of one reply; opening a position past caps.max_open_positions is rejected; shorts and leverage
// do not exist. A position's price is its curve's virtual quote over virtual token reserves; a
// CompleteEvent (or the end of data) force-closes any position in that mint at its last trade's
// reserves, and every position is flattened at the end. stdout carries replies only (diagnostics:
// console.error). Every entry runs twice and the two action logs must match byte for byte: never read
// the clock, the environment or Math.random; seed any randomness from state.hello.seed.

import { createInterface } from 'node:readline';

export const PROTOCOL = 'agent-fun/replay/v2';
/** Harness -> bot lines are at most this many UTF-8 bytes, the `\n` not counted (1 MiB). */
export const MAX_HARNESS_LINE_BYTES = 1_048_576;
/** Bot -> harness lines (replies) are at most this many UTF-8 bytes, the `\n` not counted (64 KiB). */
export const MAX_BOT_LINE_BYTES = 65_536;
/** Basis points per unit: 10_000 bps = 100%. */
export const BPS = 10_000n;
export const U64_MAX = 18_446_744_073_709_551_615n;
/** Lamports per SOL. */
export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Fixed-point scale of priceScaled(): price x 10^12, in lamports per token unit. */
export const PRICE_SCALE = 1_000_000_000_000n;

// ---------------------------------------------------------------- wire types (contracts/protocol.ts)

/** A u64 as a canonical decimal string; read it with BigInt. */
export type U64 = string;
export type Side = 'buy' | 'sell';
export interface Universe {
  program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  quote: 'SOL';
  mayhem: 'excluded';
  exclude_cashback: true;
  sample: { hash: 'sha256'; modulus: number; residue: number };
}
export interface Capital { lamports: U64 }
export interface Caps {
  max_open_positions: number;
  max_order_bps_of_real_reserve: number;
  max_orders_per_batch: number;
  shorts: false;
  leverage: false;
}
export interface Fees {
  protocol_bps_fallback: number;
  creator_bps_fallback: number;
  base_fee_lamports: U64;
  priority_fee_lamports: U64;
  failed_tx_bps: number;
}
export interface Hello {
  type: 'hello';
  protocol: typeof PROTOCOL;
  seed: U64;
  universe: Universe;
  capital: Capital;
  caps: Caps;
  latency_slots: number;
  fees: Fees;
}
/** A mint's bonding-curve reserves after the recorded trade at `slot`. */
export interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}
export interface Position { mint: string; token_amount: U64; cost_lamports: U64 }
export interface Account { cash_lamports: U64; positions: Position[] }
export const REJECT_REASONS = [
  'max_slippage', 'max_open_positions', 'max_order_size', 'max_orders_per_batch', 'insufficient_cash',
  'insufficient_tokens', 'not_in_universe', 'token_complete', 'zero_amount', 'duplicate_client_id', 'after_end',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export interface Fill {
  client_id: string;
  mint: string;
  side: Side;
  status: 'filled' | 'rejected' | 'failed';
  reason: RejectReason | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
  fee_fallback: boolean;
}
/** A pump.fun trade, carrying the curve's post-trade reserves (the full record has more fields). */
export interface TradeEvent {
  event: 'TradeEvent';
  mint: string;
  sol_amount: U64;
  token_amount: U64;
  is_buy: boolean;
  virtual_sol_reserves: U64;
  virtual_token_reserves: U64;
  real_sol_reserves: U64;
  real_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_quote_reserves: U64;
  slot: number;
  signature: string;
  block_time: number | null;
  chain_seq: number;
}
export interface CreateEvent {
  event: 'CreateEvent';
  mint: string;
  slot: number;
  signature: string;
  block_time: number | null;
  chain_seq: number;
}
export interface CompleteEvent {
  event: 'CompleteEvent';
  mint: string;
  slot: number;
  signature: string;
  block_time: number | null;
  chain_seq: number;
}
export type ChainEvent = TradeEvent | CreateEvent | CompleteEvent;
export interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: Account;
}
export interface Done { type: 'done'; seq: number; reason: 'end_of_data' | 'aborted'; account: Account }
export type HarnessMessage = Hello | Batch | Done;
export interface BuyOrder { side: 'buy'; client_id: string; mint: string; quote_lamports: U64; max_slippage_bps: number }
export interface SellOrder { side: 'sell'; client_id: string; mint: string; token_amount: U64; max_slippage_bps: number }
export type Order = BuyOrder | SellOrder;
export interface Reply { type: 'reply'; seq: number; orders: Order[] }

/** bigint, a u64 decimal string, or a non-negative safe integer. */
export type Amount = bigint | string | number;
/** A buy: SOL to spend, curve fees included. client_id is assigned when omitted. */
export interface BuyInput { side: 'buy'; mint: string; quote_lamports: Amount; max_slippage_bps: number; client_id?: string }
/** A sell: raw token units (the position's token_amount). */
export interface SellInput { side: 'sell'; mint: string; token_amount: Amount; max_slippage_bps: number; client_id?: string }
export type OrderInput = BuyInput | SellInput;

/** The harness sent something this shim cannot follow. */
export class ProtocolError extends Error {
  override name = 'ProtocolError';
}
/** The bot returned something the harness would treat as a protocol violation. */
export class OrderError extends Error {
  override name = 'OrderError';
}

const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;
const KEYS = {
  buy: ['side', 'client_id', 'mint', 'quote_lamports', 'max_slippage_bps'],
  sell: ['side', 'client_id', 'mint', 'token_amount', 'max_slippage_bps'],
};

/** One mint's latest bonding-curve reserves, as bigints. */
export interface Reserves { vt: bigint; vq: bigint; rt: bigint; rq: bigint; slot: number }

/** Everything the bot knows, current before each callback. Unit-test a strategy with `s = new PumpState(hello); s.applyBatch(b)`. */
export class PumpState {
  readonly hello: Hello;
  /** Seq and slot of the batch being answered (-1 before the first). */
  seq = -1;
  slot = -1;
  /** Slot of the first batch seen (-1 before the first): the window's start for elapsed-slot math. */
  firstSlot = -1;
  account: Account;
  /** The account's cash in lamports. */
  cash: bigint;
  /** Held token amounts and their cost (fees included), by mint. */
  readonly positions = new Map<string, { tokens: bigint; cost: bigint }>();
  /** Each mint's latest reserves, from its marks and trade events; absent until first seen. */
  readonly reserves = new Map<string, Reserves>();
  /** Mints whose bonding curve completed (a buy there is rejected token_complete). */
  readonly completed = new Set<string>();
  #used = new Set<string>();
  #next = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.cash = BigInt(hello.capital.lamports);
    this.account = { cash_lamports: hello.capital.lamports, positions: [] };
  }

  /** Slots elapsed since the first batch (0 on the first batch, -1 before it). */
  get elapsedSlots(): number {
    return this.firstSlot < 0 ? -1 : this.slot - this.firstSlot;
  }

  /** The mint's latest reserves, or undefined before its first mark or trade. */
  at(mint: string): Reserves | undefined {
    return this.reserves.get(mint);
  }

  /**
   * The mint's price x PRICE_SCALE (lamports per token unit): virtual quote over virtual token
   * reserves, truncated. Null before the mint's first mark or trade, or on empty reserves.
   */
  priceScaled(mint: string): bigint | null {
    const r = this.reserves.get(mint);
    if (r === undefined || r.vt <= 0n) return null;
    return (r.vq * PRICE_SCALE) / r.vt;
  }

  /** The mint's real SOL reserve (lamports), the base of the 1%-of-reserve buy cap; null before its first mark or trade. */
  realReserve(mint: string): bigint | null {
    const r = this.reserves.get(mint);
    return r === undefined ? null : r.rq;
  }

  /** The flat tx fee of one order (base + priority), in lamports. */
  txFee(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  /**
   * The largest buy this mint may take in one reply under caps.max_order_bps_of_real_reserve,
   * shaved by `safetyBps` (default 1000 = keep 10% of headroom under the cap), or 0n without
   * reserves. The cap counts every buy of the mint in the same reply, so size one buy per mint
   * per reply against this number.
   */
  buyCap(mint: string, safetyBps = 1000): bigint {
    const rq = this.realReserve(mint);
    if (rq === null) return 0n;
    const capBps = BigInt(this.hello.caps.max_order_bps_of_real_reserve);
    return (rq * capBps * (BPS - BigInt(safetyBps))) / (BPS * BPS);
  }

  /** A fresh client_id (o1, o2, ...) never used in this run. */
  clientId(): string {
    const id = this.#freeId(new Set());
    this.#used.add(id);
    return id;
  }

  /** Fold a batch in (events, then marks, then the account). runPump calls this. */
  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    if (this.firstSlot < 0) this.firstSlot = batch.slot;
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') {
        const t = e as TradeEvent;
        this.reserves.set(t.mint, {
          vt: BigInt(t.virtual_token_reserves),
          vq: BigInt(t.virtual_quote_reserves),
          rt: BigInt(t.real_token_reserves),
          rq: BigInt(t.real_quote_reserves),
          slot: t.slot,
        });
      } else if (e.event === 'CompleteEvent') {
        this.completed.add(e.mint);
      }
    }
    for (const m of batch.marks) {
      this.reserves.set(m.mint, {
        vt: BigInt(m.virtual_token_reserves),
        vq: BigInt(m.virtual_quote_reserves),
        rt: BigInt(m.real_token_reserves),
        rq: BigInt(m.real_quote_reserves),
        slot: m.slot,
      });
    }
    this.#setAccount(batch.account);
  }

  /** Fold the final account in. runPump calls this before onDone. */
  applyDone(done: Done): void {
    this.seq = done.seq;
    this.#setAccount(done.account);
  }

  /** What onBatch returned as wire orders (missing client_ids assigned); throws OrderError on a violation or too many orders. */
  toOrders(result: unknown): Order[] {
    if (result === undefined || result === null) return [];
    if (!Array.isArray(result)) throw new OrderError(`batch ${this.seq}: onBatch must return an array of orders, got ${describe(result)}`);
    const cap = this.hello.caps.max_orders_per_batch;
    if (result.length > cap) throw new OrderError(`batch ${this.seq}: onBatch returned ${result.length} orders, over hello.caps.max_orders_per_batch (${cap}): the harness rejects every order past it`);
    const checked = result.map((o: unknown, i: number) => checkOrder(o, `batch ${this.seq} order ${i}`));
    const taken = new Set(checked.flatMap((o) => (o.client_id === undefined ? [] : [o.client_id])));
    return checked.map((o): Order => {
      const client_id = o.client_id ?? this.#freeId(taken);
      taken.add(client_id);
      return o.side === 'buy'
        ? { side: 'buy', client_id, mint: o.mint, quote_lamports: o.amount, max_slippage_bps: o.bps }
        : { side: 'sell', client_id, mint: o.mint, token_amount: o.amount, max_slippage_bps: o.bps };
    });
  }

  /** Record orders as sent: their ids are never assigned again. */
  recordOrders(orders: readonly Order[]): void {
    for (const o of orders) this.#used.add(o.client_id);
  }

  #freeId(taken: Set<string>): string {
    for (;;) {
      const id = `o${this.#next++}`;
      if (!this.#used.has(id) && !taken.has(id)) return id;
    }
  }

  #setAccount(account: Account): void {
    this.account = account;
    this.cash = BigInt(account.cash_lamports);
    this.positions.clear();
    for (const p of account.positions) this.positions.set(p.mint, { tokens: BigInt(p.token_amount), cost: BigInt(p.cost_lamports) });
  }
}

function checkOrder(value: unknown, where: string): { side: Side; client_id: string | undefined; mint: string; amount: U64; bps: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new OrderError(`${where}: expected an order object, got ${describe(value)}`);
  const o = value as Record<string, unknown>;
  if (o.side !== 'buy' && o.side !== 'sell') throw new OrderError(`${where}: side must be "buy" or "sell", got ${describe(o.side)}`);
  const keys = KEYS[o.side];
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new OrderError(`${where}: unknown key "${k}" on a ${o.side} order`);
  if (typeof o.mint !== 'string' || !PUBKEY_RE.test(o.mint)) throw new OrderError(`${where}: mint must be a base58 pubkey, got ${describe(o.mint)}`);
  const amountKey = keys[3]!;
  const amount = toU64(o[amountKey], `${where}: ${amountKey}`);
  const bps = o.max_slippage_bps;
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new OrderError(`${where}: max_slippage_bps must be an integer 0..10000, got ${describe(bps)}`);
  if (o.client_id !== undefined && (typeof o.client_id !== 'string' || !CLIENT_ID_RE.test(o.client_id))) {
    throw new OrderError(`${where}: client_id must be 1-64 of [A-Za-z0-9_-] not starting with _ (reserved for the harness's closes), got ${describe(o.client_id)}`);
  }
  return { side: o.side, client_id: o.client_id as string | undefined, mint: o.mint, amount, bps };
}

/** An amount as a canonical u64 decimal string; throws OrderError when it is not one. */
export function toU64(value: unknown, what = 'amount'): U64 {
  let n: bigint | null = null;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && U64_RE.test(value)) n = BigInt(value);
  if (n === null || n < 0n || n > U64_MAX) throw new OrderError(`${what} must be a u64 (bigint, decimal string or safe integer), got ${describe(value)}`);
  return n.toString();
}

function describe(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? 'an array' : 'an object';
}

// ---------------------------------------------------------------- the line loop

/** Where replies go (process.stdout by default); a false from write() waits for 'drain' when once() exists. */
export interface LineWriter {
  write(chunk: string): unknown;
  once?(event: 'drain', listener: () => void): unknown;
}
export type OrdersResult = readonly OrderInput[] | void | null | undefined;
export interface Bot {
  onHello?(state: PumpState): void | Promise<void>;
  onBatch(state: PumpState, batch: Batch): OrdersResult | Promise<OrdersResult>;
  /** After the final account (flattened) took effect; no reply is sent. */
  onDone?(state: PumpState, done: Done): void | Promise<void>;
}

/**
 * Speak agent-fun/replay/v2 until done, then stop reading and resolve (the process exits once
 * stdout drains, even with stdin left open). Rejects with ProtocolError, OrderError or what a callback
 * threw; unhandled, that ends the process with exit code 1.
 */
export async function runPump(bot: Bot, io: { input?: NodeJS.ReadableStream; output?: LineWriter } = {}): Promise<{ state: PumpState; done: Done; batches: number }> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const encoder = new TextEncoder();
  const lines = createInterface({ input, crlfDelay: Infinity });
  let state: PumpState | null = null;
  let lineNo = 0;
  try {
    for await (const line of lines) {
      lineNo++;
      if (encoder.encode(line).byteLength > MAX_HARNESS_LINE_BYTES) throw new ProtocolError(`input line ${lineNo} is over ${MAX_HARNESS_LINE_BYTES} bytes`);
      if (line.trim() === '') continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        throw new ProtocolError(`input line ${lineNo} is not JSON`);
      }
      const type = typeof msg === 'object' && msg !== null ? msg.type : undefined;
      if (type === 'hello') {
        if (state !== null) throw new ProtocolError(`input line ${lineNo}: a second hello`);
        if (msg.protocol !== PROTOCOL) throw new ProtocolError(`the harness speaks ${describe(msg.protocol)}; this shim speaks ${PROTOCOL}`);
        state = new PumpState(msg as unknown as Hello);
        await bot.onHello?.(state);
      } else if (type === 'batch' || type === 'done') {
        if (state === null) throw new ProtocolError(`input line ${lineNo}: ${type} before hello`);
        const a = msg.account as Account | undefined;
        const shaped = msg.seq === state.seq + 1 && typeof a === 'object' && a !== null && Array.isArray(a.positions);
        if (type === 'done') {
          if (!shaped) throw new ProtocolError(`input line ${lineNo}: malformed done (seq ${describe(msg.seq)} after batch ${state.seq})`);
          const done = msg as unknown as Done;
          state.applyDone(done);
          await bot.onDone?.(state, done);
          return { state, done, batches: done.seq };
        }
        if (!shaped || !Number.isSafeInteger(msg.slot) || !Array.isArray(msg.events) || !Array.isArray(msg.marks) || !Array.isArray(msg.fills)) {
          throw new ProtocolError(`input line ${lineNo}: malformed batch (seq ${describe(msg.seq)} after ${state.seq})`);
        }
        const batch = msg as unknown as Batch;
        state.applyBatch(batch);
        const orders = state.toOrders(await bot.onBatch(state, batch));
        const text = JSON.stringify({ type: 'reply', seq: batch.seq, orders } satisfies Reply);
        const bytes = encoder.encode(text).byteLength;
        if (bytes > MAX_BOT_LINE_BYTES) throw new OrderError(`batch ${batch.seq}: the reply is ${bytes} bytes (max ${MAX_BOT_LINE_BYTES})`);
        state.recordOrders(orders);
        if (output.write(`${text}\n`) === false && output.once) await new Promise<void>((resolve) => output.once!('drain', resolve));
      } else throw new ProtocolError(`input line ${lineNo}: unknown message type ${describe(type)}`);
    }
  } finally {
    lines.close();
    if (input === process.stdin) process.stdin.destroy();
  }
  throw new ProtocolError(state === null ? 'input ended before hello' : `input ended before done (after ${state.seq + 1} batches)`);
}
