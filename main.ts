// Early-breakout momentum scalper for u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b
// (agent-fun/replay/v2, 6-hour pump.fun forward window, ranked by net PnL, winner takes all).
//
// The 6-hour window rewards catching a runner in its first minutes, not holding it all day: a
// pump.fun coin that is going to move usually does it fast, and one that stalls rarely comes back.
// So this bot buys early strength, rides it with a tight trailing stop, and gets out quickly when
// the move dies — then recycles the freed slot into the next fresh coin. Few, fast trades.
//
// Rules:
// - Entry: a coin up >= 12% over ~120 slots (~50 seconds) from its own price ~2 minutes ago, trading
//   within 4% of its observed high (a breakout, not a bounce), with >= 3 trades seen, first seen
//   20..3600 slots ago (fresh, but past the very first tick), and a real SOL reserve >= 3 SOL so the
//   1%-of-reserve buy cap still allows a real position. The 12% bar is deliberate: a coin that has
//   only risen 8-9% has usually already spent its move by the time the bot can measure it, and the
//   bot would buy the top and eat the dump; 12% selects moves with follow-through. A second, faster
//   entry fires on >= 6% over ~40 slots (~16 seconds): it catches a hot coin earlier in its move,
//   before the 120-slot filter can even see it. At most 3 new buys per batch, best momentum first,
//   one position per mint.
// - Size: 0.4 SOL per trade, capped at 0.9% of the mint's real reserve (the harness rejects buys
//   over 1% of real reserve at decision time) and skipped below 0.03 SOL. A round trip costs about
//   1.25% of curve fees each way plus 2 x 105,000 lamports of tx fees (~2.6% at 0.4 SOL), so the
//   12% entry filter clears the fee hurdle with room to spare.
// - Exits (checked every batch on every held position): trailing stop 5% below the peak since
//   entry, hard stop 8% below the fee-loaded entry price, time stop after 1,500 slots (~10 min)
//   held. No fixed take-profit: in a 6-hour sprint the upside is the point, and the trailing stop
//   banks it. Sells are always the full position, so every exit closes a round trip.
// - The 20-coin bar: the competition ranks entries that miss "a round trip of >= 0.01 SOL on each
//   of >= 20 coins, max drawdown <= 50%" below every entry that meets it. With 5 open slots and
//   ~10-minute holds this bot can cycle far more than 20 coins in 6 hours; as a safety net, after
//   36,000 slots (~4 hours) with fewer than 20 round trips closed, the entry filter loosens to
//   5% momentum, 2 trades, 2 SOL reserve, age up to 7,200 slots.
// - No new entries after 48,000 slots past the first batch (~5.3 hours in): a buy that late has no
//   time to play out before the end flattening and only pays fees. No shorts, no leverage (the
//   harness forbids both), no adds to an open position, 900-slot cooldown per mint after any exit.
// - Pending orders: buys and sells are tracked by client_id and cleared on their fill (filled,
//   rejected or failed) or after 60 slots without one; a mint with a pending buy is never
//   double-bought, and a pending sell blocks a second sell. A position that vanishes without our
//   sell (curve completion force-close, end flattening) still counts as a closed round trip.
// - No clock, no network, no randomness: fully deterministic (the same replay always produces the
//   same orders; the grader runs each entry twice and the action logs must match byte for byte).
//
// Parameters are constants below. Slots run ~0.4 s on Solana, so 120 slots ~= 50 seconds, 1,500
// slots ~= 10 minutes, 48,000 slots ~= 5.3 hours. All timing is in slots from the first batch, so
// the bot works whatever the harness's batch cadence is.

import {
  BPS,
  LAMPORTS_PER_SOL,
  PRICE_SCALE,
  runPump,
  type Batch,
  type OrderInput,
  type PumpState,
} from './vendor/makefun-pump.ts';

// --- Strategy parameters (bps = 1/100 of 1%; slots ~= 0.4 s) ---
const MOMENTUM_BPS = 1200n; // entry: +12% over the ~120-slot lookback
const MOMENTUM_LOOKBACK_SLOTS = 120; // how far back the momentum reference sits
const MOMENTUM_MIN_AGE_SLOTS = 60; // the reference must be at least this old
const FAST_MOMENTUM_BPS = 600n; // fast entry: +6% over the ~40-slot lookback
const FAST_LOOKBACK_SLOTS = 40; // fast lookback: catch a hot coin early
const FAST_MIN_AGE_SLOTS = 30; // the fast reference must be at least this old
const BREAKOUT_BPS = 400n; // entry: price within 4% of the sampled high
const MIN_TRADES = 3; // entry: at least this many trades seen on the mint
const MIN_AGE_SLOTS = 20; // entry: ignore a coin's very first ticks
const MAX_AGE_SLOTS = 3600; // entry: only fresh coins (~24 min)
const MIN_REAL_RESERVE = 3n * LAMPORTS_PER_SOL; // entry: real SOL reserve floor
const TARGET_BUY = 400_000_000n; // 0.4 SOL per trade
const MIN_BUY = 30_000_000n; // 0.03 SOL: below this the trade is not worth its fees
const TRAIL_BPS = 500n; // exit: 5% below the peak since entry
const STOP_BPS = 800n; // exit: 8% below the fee-loaded entry price
const MAX_HOLD_SLOTS = 1500; // exit: time stop (~10 min)
const COOLDOWN_SLOTS = 900; // wait this long after an exit before re-entering a mint
const MAX_BUYS_PER_BATCH = 3; // cap new entries per batch
const PENDING_TIMEOUT_SLOTS = 60; // give up on an unresolved order after this
const NO_ENTRY_AFTER_SLOTS = 48_000; // stop opening near the end of the 6h window
const CATCH_UP_AFTER_SLOTS = 36_000; // loosen the filter after this if the 20-coin bar is at risk
const CATCH_UP_MOMENTUM_BPS = 500n; // loosened entry: +5%
const CATCH_UP_MIN_TRADES = 2; // loosened entry: 2 trades
const CATCH_UP_MIN_RESERVE = 2n * LAMPORTS_PER_SOL; // loosened entry: 2 SOL reserve
const CATCH_UP_MAX_AGE_SLOTS = 7200; // loosened entry: age up to ~48 min
const ROUND_TRIP_TARGET = 20; // the competition's minimum bar (distinct coins)
const BUY_SLIPPAGE_BPS = 500; // 5%: wide enough for a 2-slot fill on a moving coin
const SELL_SLIPPAGE_BPS = 800; // 8%: exits must execute, even on a fast dump
const SAMPLE_GAP_SLOTS = 15; // keep one price sample per ~15 slots per mint
const MAX_SAMPLES = 16; // ring size: ~16 samples cover the lookback with margin
const PRUNE_AFTER_SLOTS = 7200; // drop a mint's history after this long unseen
const PRUNE_EVERY_BATCHES = 512; // how often to sweep stale history

// --- Per-mint market history (built from events + marks only) ---
interface CoinTrack {
  firstSlot: number; // slot the mint was first seen
  firstPrice: bigint; // price x PRICE_SCALE at first sight
  samples: { slot: number; price: bigint }[]; // sampled prices, oldest first
  trades: number; // TradeEvents seen on this mint
  lastSlot: number; // slot it was last seen (for pruning)
}

// --- Per-position exit state (reconciled from the account every batch) ---
interface HeldTrack {
  entryPrice: bigint; // fee-loaded entry: cost/tokens, x PRICE_SCALE
  peak: bigint; // highest price since entry, x PRICE_SCALE
  entrySlot: number; // slot the position first appeared
}

const coins = new Map<string, CoinTrack>();
const held = new Map<string, HeldTrack>();
const pendingBuy = new Map<string, { clientId: string; slot: number; spend: bigint }>();
const pendingSell = new Map<string, { clientId: string; slot: number }>();
const pendingById = new Map<string, { mint: string; side: 'buy' | 'sell' }>();
const cooldownUntil = new Map<string, number>();
const roundTripped = new Set<string>();
let roundTripsClosed = 0;
let pendingBuySpend = 0n;
let lastPruneSeq = -1;

/** Fee-loaded entry price of a held position (x PRICE_SCALE), or null. */
function entryPriceOf(state: PumpState, mint: string): bigint | null {
  const pos = state.positions.get(mint);
  if (!pos || pos.tokens <= 0n) return null;
  return (pos.cost * PRICE_SCALE) / pos.tokens;
}

/** The momentum reference price: the sample nearest (now - lookback), at least minAge old. */
function referencePrice(track: CoinTrack, nowSlot: number, lookback: number, minAge: number): bigint | null {
  const target = nowSlot - lookback;
  let best: { slot: number; price: bigint } | null = null;
  for (const s of track.samples) {
    if (nowSlot - s.slot < minAge) continue;
    if (best === null || Math.abs(s.slot - target) < Math.abs(best.slot - target)) best = s;
  }
  if (best !== null) return best.price;
  if (nowSlot - track.firstSlot >= minAge) return track.firstPrice;
  return null;
}

/** Momentum in bps of `price` against the reference `lookback` slots back, or null. */
function momentumBps(track: CoinTrack, price: bigint, nowSlot: number, lookback: number, minAge: number): bigint | null {
  const ref = referencePrice(track, nowSlot, lookback, minAge);
  if (ref === null || ref <= 0n) return null;
  return ((price - ref) * BPS) / ref;
}

/** Highest sampled price excluding the most recent sample (the breakout bar). */
function priorHigh(track: CoinTrack): bigint | null {
  if (track.samples.length < 2) return null;
  let high = track.samples[0]!.price;
  for (let i = 1; i < track.samples.length - 1; i++) {
    if (track.samples[i]!.price > high) high = track.samples[i]!.price;
  }
  return high;
}

function clearPending(clientId: string): void {
  const p = pendingById.get(clientId);
  if (p === undefined) return;
  pendingById.delete(clientId);
  if (p.side === 'buy') {
    const b = pendingBuy.get(p.mint);
    if (b !== undefined && b.clientId === clientId) {
      pendingBuySpend -= b.spend;
      pendingBuy.delete(p.mint);
    }
  } else {
    const s = pendingSell.get(p.mint);
    if (s !== undefined && s.clientId === clientId) pendingSell.delete(p.mint);
  }
}

function onBatch(state: PumpState, batch: Batch): OrderInput[] {
  const slot = batch.slot;
  const orders: OrderInput[] = [];

  // --- 1. Fold this batch's mints into history (events first, then marks) ---
  const touched = new Set<string>();
  const tradeCounts = new Map<string, number>();
  for (const e of batch.events) {
    touched.add(e.mint);
    if (e.event === 'TradeEvent') tradeCounts.set(e.mint, (tradeCounts.get(e.mint) ?? 0) + 1);
  }
  for (const m of batch.marks) touched.add(m.mint);
  for (const mint of touched) {
    const price = state.priceScaled(mint);
    if (price === null) continue;
    let t = coins.get(mint);
    if (t === undefined) {
      t = { firstSlot: slot, firstPrice: price, samples: [], trades: 0, lastSlot: slot };
      coins.set(mint, t);
    }
    t.trades += tradeCounts.get(mint) ?? 0;
    t.lastSlot = slot;
    const last = t.samples[t.samples.length - 1];
    if (last === undefined || slot - last.slot >= SAMPLE_GAP_SLOTS) {
      t.samples.push({ slot, price });
      if (t.samples.length > MAX_SAMPLES) t.samples.shift();
    }
  }
  // --- 2. Resolve pending orders from this batch's fills ---
  for (const f of batch.fills) clearPending(f.client_id);
  for (const [mint, p] of pendingBuy) {
    if (state.positions.has(mint) || slot - p.slot >= PENDING_TIMEOUT_SLOTS) clearPending(p.clientId);
  }
  for (const [mint, p] of pendingSell) {
    if (!state.positions.has(mint) || slot - p.slot >= PENDING_TIMEOUT_SLOTS) clearPending(p.clientId);
  }

  // --- 3. Reconcile held positions: new ones get exit state, gone ones close a round trip ---
  for (const mint of state.positions.keys()) {
    if (held.has(mint)) continue;
    const entry = entryPriceOf(state, mint);
    if (entry === null) continue;
    const now = state.priceScaled(mint);
    held.set(mint, { entryPrice: entry, peak: now !== null && now > entry ? now : entry, entrySlot: slot });
  }
  for (const mint of [...held.keys()]) {
    if (state.positions.has(mint)) continue;
    held.delete(mint);
    cooldownUntil.set(mint, slot + COOLDOWN_SLOTS);
    if (!roundTripped.has(mint)) {
      roundTripped.add(mint);
      roundTripsClosed++;
    }
  }

  // --- 4. Exits: trailing stop, hard stop, time stop (full position, one sell per mint) ---
  for (const [mint, h] of held) {
    if (pendingSell.has(mint)) continue;
    const pos = state.positions.get(mint);
    if (pos === undefined || pos.tokens <= 0n) continue;
    const price = state.priceScaled(mint);
    if (price === null) continue; // no fresh price: hold rather than sell blind
    if (price > h.peak) h.peak = price;
    const trailed = price * BPS <= h.peak * (BPS - TRAIL_BPS);
    const stopped = price * BPS <= h.entryPrice * (BPS - STOP_BPS);
    const stale = slot - h.entrySlot >= MAX_HOLD_SLOTS;
    if (!trailed && !stopped && !stale) continue;
    const clientId = state.clientId();
    pendingSell.set(mint, { clientId, slot });
    pendingById.set(clientId, { mint, side: 'sell' });
    orders.push({ side: 'sell', mint, token_amount: pos.tokens, max_slippage_bps: SELL_SLIPPAGE_BPS, client_id: clientId });
  }

  // --- 5. Entries: best momentum first, up to the free slots ---
  const elapsed = state.elapsedSlots;
  const maxOpen = state.hello.caps.max_open_positions;
  const freeSlots = maxOpen - state.positions.size - pendingBuy.size;
  if (freeSlots > 0 && elapsed >= 0 && elapsed < NO_ENTRY_AFTER_SLOTS) {
    const catchUp = elapsed >= CATCH_UP_AFTER_SLOTS && roundTripsClosed < ROUND_TRIP_TARGET;
    const needBps = catchUp ? CATCH_UP_MOMENTUM_BPS : MOMENTUM_BPS;
    const needTrades = catchUp ? CATCH_UP_MIN_TRADES : MIN_TRADES;
    const needReserve = catchUp ? CATCH_UP_MIN_RESERVE : MIN_REAL_RESERVE;
    const maxAge = catchUp ? CATCH_UP_MAX_AGE_SLOTS : MAX_AGE_SLOTS;
    const txFee = state.txFee();
    // Reserve exit fees: every open position needs one sell fee to close, and
    // a bot that spends its last lamports on buys strands its positions (a
    // sell with no cash for its tx fee is rejected). Keep one buy fee plus one
    // sell fee per open slot in reserve.
    const exitFeeReserve = txFee * BigInt(1 + maxOpen);
    let cashLeft = state.cash - pendingBuySpend - exitFeeReserve;

    const candidates: { mint: string; score: bigint; size: bigint }[] = [];
    for (const mint of touched) {
      if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
      if (state.completed.has(mint)) continue;
      const cool = cooldownUntil.get(mint);
      if (cool !== undefined && slot < cool) continue;
      const t = coins.get(mint);
      if (t === undefined || t.trades < needTrades) continue;
      const age = slot - t.firstSlot;
      if (age < MIN_AGE_SLOTS || age > maxAge) continue;
      const price = state.priceScaled(mint);
      if (price === null) continue;
      // Either the slow filter (a strong move over ~2 minutes) or the fast one (a hot coin
      // moving now) qualifies; the score is the stronger of the two, for ranking.
      const slow = momentumBps(t, price, slot, MOMENTUM_LOOKBACK_SLOTS, MOMENTUM_MIN_AGE_SLOTS);
      const fast = momentumBps(t, price, slot, FAST_LOOKBACK_SLOTS, FAST_MIN_AGE_SLOTS);
      const slowOk = slow !== null && slow >= needBps;
      const fastOk = fast !== null && fast >= FAST_MOMENTUM_BPS;
      if (!slowOk && !fastOk) continue;
      const score = slow !== null && fast !== null ? (slow > fast ? slow : fast) : (slow ?? fast)!;
      const high = priorHigh(t);
      if (high !== null && price * BPS < high * (BPS - BREAKOUT_BPS)) continue;
      const reserve = state.realReserve(mint);
      if (reserve === null || reserve < needReserve) continue;
      let size = TARGET_BUY;
      const cap = state.buyCap(mint);
      if (cap < size) size = cap;
      if (size < MIN_BUY) continue;
      candidates.push({ mint, score, size });
    }
    // Best momentum first; mint breaks ties so the order is deterministic.
    candidates.sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : a.mint < b.mint ? -1 : 1));
    const buys = Math.min(freeSlots, MAX_BUYS_PER_BATCH, candidates.length);
    for (let i = 0; i < buys; i++) {
      const c = candidates[i]!;
      if (c.size + txFee > cashLeft) continue;
      cashLeft -= c.size + txFee;
      const clientId = state.clientId();
      pendingBuy.set(c.mint, { clientId, slot, spend: c.size });
      pendingBuySpend += c.size;
      pendingById.set(clientId, { mint: c.mint, side: 'buy' });
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: c.size, max_slippage_bps: BUY_SLIPPAGE_BPS, client_id: clientId });
    }
  }

  // --- 6. Prune stale history (bounded memory over a 6-hour window) ---
  if (batch.seq - lastPruneSeq >= PRUNE_EVERY_BATCHES) {
    lastPruneSeq = batch.seq;
    for (const [mint, t] of coins) {
      if (slot - t.lastSlot <= PRUNE_AFTER_SLOTS) continue;
      if (state.positions.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint)) continue;
      coins.delete(mint);
    }
    for (const [mint, until] of cooldownUntil) {
      if (slot >= until) cooldownUntil.delete(mint);
    }
  }

  return orders;
}

await runPump({ onBatch });
