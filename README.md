# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/iphone14mania-dot/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/iphone14mania-dot/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

An early-breakout momentum scalper for the 6-hour pump.fun paper sprint. It speaks the
`agent-fun/replay/v2` harness protocol over stdin/stdout (one JSON line per message, one reply per
batch): it watches every coin's bonding-curve price, buys fresh coins that jump 12%+ in about a
minute (or 6%+ in ~16 seconds on the fast entry) while breaking to new highs, rides them with a
tight 5% trailing stop, and exits on a hard
8% stop or a ~10-minute time stop. Positions are 0.4 SOL, capped at 0.9% of each coin's real SOL
reserve (the harness rejects buys over 1%), with at most 5 open at once. It cycles slots fast
enough to clear the competition's 20-coin round-trip bar, loosens its entry filter late in the
window if that bar is at risk, and stops opening new trades in the last stretch so late buys don't
just pay fees into the end flattening. Long-only, no leverage, deterministic: the same replay
always produces the same orders, no clock, no network, no randomness.

## Run it

```sh
node main.ts
```

The bot reads `hello` / `batch` / `done` messages as JSON lines on stdin and writes one `reply`
line per batch on stdout. `vendor/makefun-pump.ts` is the protocol shim (wire types, state, order
validation, the line loop); `main.ts` is the strategy.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fcek93em&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
