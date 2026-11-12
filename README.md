# solana-spend-guard

Fail-closed spending limits for bots that send real Solana transactions. Call it right before you sign. It says yes or no
and records the send. It stops your bot before a bug, a bad config or a losing streak can drain the wallet.

Taken from a liquidation bot that ran with real money. In its final live week (Nov 6–12, 2026) the bot sent 46
transactions and lost all 46 races; the guard kept the cost of that to 0.0024 SOL in fees, inside its daily limits
(see [Background](#background)).

```js
const { SpendGuard, sol, estimateTxFeeLamports, extractTipLamports } = require('solana-spend-guard');

const guard = new SpendGuard({
  stateFile: 'spend-guard-state.json',
  perTx: { maxFee: sol(0.001), maxTip: sol(0.005) },
  minReserve: sol(0.05),        // always leave this much SOL in the wallet
  minProfitToCost: 3,           // expected profit must be ≥ 3× what the send costs
  daily: { maxSends: 40, maxFailures: 30, maxFailureFees: sol(0.01), maxOutflow: sol(0.1) },
  checkpoint: sol(0.05),        // halt if the wallet falls 0.05 SOL below where it started
});

const fee = estimateTxFeeLamports(tx);   // read from the built transaction
const tip = extractTipLamports(tx);
const r = guard.reserve({ fee, tip, profit, balance, label: 'liquidate 7xKX…' });
if (!r.allowed) return console.log('guard said no:', r.reason);
// sign + send. Then, only if it lost on-chain or never landed:
guard.recordFailure(r.id, { feePaid: landed ? fee : 0, reason: 'lost the race' });
// anything you did not expect:
guard.halt('unknown error 0x1771 on liquidate');
```

`node examples/basic.js` runs this on a built (never sent) transaction.

## What it checks

`reserve()` refuses if **any** of these fail, and records nothing when it refuses:

| Check | Config |
|---|---|
| Not halted | `halt()` / `resume()`, and automatically (below) |
| Fee, tip, protocol fee and setup rent each under their own per-transaction cap | `perTx.maxFee / maxTip / maxProtocolFee / maxSetup` |
| The wallet keeps a reserve after the whole outflow | `minReserve` |
| Expected profit ≥ N × cost (optionally with the tip outside the ratio, capped at a share of profit) | `minProfitToCost`, `tipOutsideRatio.maxTipShareOfProfit` |
| Lifetime: send count and each cost kind | `lifetime.maxSends / maxFee / maxTip / maxProtocolFee / maxSetup` |
| Last 24 h: sends, failures, fees lost on failures (counting this send as if it fails), total outflow | `daily.maxSends / maxFailures / maxFailureFees / maxOutflow` |
| Balance not more than X below the balance at the first send (crossing it **halts**) | `checkpoint` |

All amounts are lamports; `sol(0.01)` converts.

## Why it is built this way

These rules each come from something that went wrong, or nearly went wrong, in the live bot:

- **Fail-closed.** Every limit must be set explicitly. A missing or zero limit refuses, so a typo in a config file
  stops the bot instead of removing a limit. A cost kind with no cap (e.g. `maxProtocolFee` unset) is refused as soon
  as a send has one.
- **Four cost kinds, kept apart.** The network fee is paid even when the transaction fails; a Jito tip and new-account
  rent revert with it; a protocol's own fee is paid every time. In the live bot, a ~6,400-lamport network fee estimate
  hid about 0.005 SOL of protocol fee and one-time rent on a real liquidation, and counting the tip as fee made a
  0.001 SOL fee cap refuse every Jito bundle.
- **Check and record in one call.** `reserve()` has no `await` inside, so two workers cannot both pass the last
  free slot. (A check-then-record pair let three parallel workers overshoot a send cap by one.)
- **State on disk, written atomically.** Bots restart. A counter kept in memory resets on every restart and stops being a
  limit. The state file is replaced with a write-then-rename, and a state file that exists but cannot be read
  **halts** instead of starting again from zero. If saving fails, the send is refused.
- **Failures release what was not paid.** A lost race pays the network fee only, so its tip and rent are taken back off the
  totals; a send that never landed pays nothing. Without this, lost races would use up the outflow budget on tips
  that were never paid.
- **Fee read from the transaction.** `estimateTxFeeLamports()` reads the signature count, the compute-unit limit and
  price, and the signatures that precompiles (Ed25519, secp256k1, secp256r1) verify. Missing the precompile signatures
  under-counted a real oracle-refresh transaction by exactly 5,000 lamports.

## Limitations

- **Legacy and v0 transactions only.** Solana's new **v1 transaction format** cannot be read by `@solana/web3.js` v1
  (`VersionedTransaction.deserialize` throws) and sets compute-unit limit and price differently. In a sample of 75
  recent transactions that paid a Jito tip, 59 were already v1. For v1, compute the fee yourself and pass it to
  `reserve()`; the guard itself does not care which format you use.
- Checked against mainnet: on 16 recent legacy/v0 transactions that paid a Jito tip, the fee estimate equaled the
  real `meta.fee` 16/16, and the tip estimate matched the tip account's balance change on every one that tipped.
- A tip sent to an address that comes from a lookup table is counted as a tip (it cannot be resolved offline). That
  over-counts, which is the safe side.
- Without a SetComputeUnitLimit instruction the fee assumes 200,000 CU per instruction. That over-counts for
  built-in programs, again on purpose.
- One process per state file. Two processes sharing a file would each see only their own sends between saves.
- It limits what you spend. It cannot tell whether a send is a good idea.

## Tests

```bash
npm install
npm test     # 24 tests, offline; nothing is signed or sent
```

## Background

This guard came out of a Kamino liquidation bot that never made money: in its final one-week live test it sent 46
liquidations and won none. Faster bots landed first every time, often refreshing the oracle price inside their own
transaction. The guard is what kept those losses small. If you are building a liquidation or MEV bot, read
[kamino-liquidation-tracker](https://github.com/emilutica1/kamino-liquidation-tracker) first.
Other tools from the same project:
[kamino-health-scanner](https://github.com/emilutica1/kamino-health-scanner),
[kamino-liquidation-alerts](https://github.com/emilutica1/kamino-liquidation-alerts),
[solana-latency-toolkit](https://github.com/emilutica1/solana-latency-toolkit).

## Credits

Built by [emilutica1](https://github.com/emilutica1) and Claude, Anthropic's AI model, working together through
[Claude Code](https://claude.com/claude-code).

## License

MIT
