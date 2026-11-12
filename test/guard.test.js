'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SpendGuard, sol } = require('..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-guard-test-'));
let n = 0;
const quiet = () => {};
const BASE = {
  perTx: { maxFee: sol(0.005), maxTip: sol(0.01), maxSetup: sol(0.003) },
  minReserve: sol(0.1),
  minProfitToCost: 3,
  lifetime: { maxSends: 5, maxFee: sol(0.01), maxTip: sol(0.03), maxSetup: sol(0.006) },
};
function make(config = BASE, file) {
  let t = 1_800_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const g = new SpendGuard({ ...config, stateFile: file || path.join(dir, `g${n++}.json`), now: clock.now, log: quiet });
  return { g, clock };
}
// a typical send: 5,000 L fee, 0.001 SOL tip, expected profit 0.01 SOL, 0.5 SOL in the wallet
const SEND = { fee: 5000, tip: sol(0.001), profit: sol(0.01), balance: sol(0.5) };

test('refuses everything when nothing is configured', () => {
  const { g } = make({});
  const r = g.reserve(SEND);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not configured/);
});

test('refuses when no budget (lifetime or daily) is configured', () => {
  const { g } = make({ ...BASE, lifetime: undefined });
  assert.match(g.reserve(SEND).reason, /no budget/);
});

test('allows a normal send and records it', () => {
  const { g } = make();
  const r = g.reserve(SEND);
  assert.equal(r.allowed, true);
  assert.equal(g.state.totals.sends, 1);
  assert.equal(g.state.totals.tip, sol(0.001));
});

test('per-transaction caps, each cost kind on its own', () => {
  const { g } = make();
  assert.match(g.reserve({ ...SEND, fee: sol(0.006) }).reason, /fee .* per-transaction cap/);
  assert.match(g.reserve({ ...SEND, tip: sol(0.02), profit: sol(1) }).reason, /tip .* per-transaction cap/);
  assert.match(g.reserve({ ...SEND, protocolFee: 1000 }).reason, /protocolFee .* not configured/);
  assert.equal(g.state.totals.sends, 0, 'refusals record nothing');
});

test('missing fee estimate is refused', () => {
  const { g } = make();
  assert.match(g.reserve({ ...SEND, fee: 0 }).reason, /fee estimate missing/);
});

test('reserve: the wallet must keep minReserve after the full outflow', () => {
  const { g } = make();
  assert.match(g.reserve({ ...SEND, balance: sol(0.1005) }).reason, /below the 0.100000 SOL reserve/);
  assert.equal(g.reserve({ ...SEND, balance: sol(0.102) }).allowed, true);
});

test('profit must be at least minProfitToCost × the cost', () => {
  const { g } = make();
  // cost = 5,000 + 1,000,000 = 1,005,000 L; 3× = 3,015,000 L
  assert.match(g.reserve({ ...SEND, profit: 3_000_000 }).reason, /less than 3×/);
  assert.equal(g.reserve({ ...SEND, profit: 3_015_000 }).allowed, true);
});

test('tip can be left out of the profit ratio, but only with a tip-share cap', () => {
  const { g } = make({ ...BASE, tipOutsideRatio: { maxTipShareOfProfit: 0.3 } });
  // profit 0.002 SOL: ratio base is the fee only (15,000 L needed), tip 0.001 SOL is 50% of profit → refused
  assert.match(g.reserve({ ...SEND, profit: sol(0.002) }).reason, /more than 30% of the expected profit/);
  assert.equal(g.reserve({ ...SEND, profit: sol(0.004) }).allowed, true);
});

test('lifetime limits: send count and each cost budget', () => {
  const { g } = make();
  for (let i = 0; i < 5; i++) assert.equal(g.reserve(SEND).allowed, true);
  assert.match(g.reserve(SEND).reason, /lifetime send limit reached \(5\/5\)/);
  const { g: g2 } = make();
  for (let i = 0; i < 3; i++) assert.equal(g2.reserve({ ...SEND, setup: sol(0.002), profit: sol(1) }).allowed, true);
  assert.match(g2.reserve({ ...SEND, setup: sol(0.002), profit: sol(1) }).reason, /lifetime setup budget/);
});

test('a lost send releases its tip and setup; a send that never landed releases its fee too', () => {
  const { g } = make();
  const a = g.reserve({ ...SEND, setup: sol(0.002), profit: sol(1) });
  g.recordFailure(a.id, { feePaid: 5000, reason: 'lost the race' });
  assert.deepEqual([g.state.totals.fee, g.state.totals.tip, g.state.totals.setup], [5000, 0, 0]);
  const b = g.reserve(SEND);
  g.recordFailure(b.id, { feePaid: 0, reason: 'blockhash expired' });
  assert.deepEqual([g.state.totals.fee, g.state.totals.tip], [5000, 0]);
  assert.equal(g.state.totals.sends, 2, 'it still counts as a send');
  g.recordFailure(b.id, { feePaid: 0 });   // reporting twice does not release twice
  assert.equal(g.state.totals.fee, 5000);
});

const DAILY = { ...BASE, lifetime: undefined, daily: { maxSends: 3, maxFailures: 2, maxFailureFees: 12_000, maxOutflow: sol(0.01) } };

test('daily: send limit, and the window rolls after 24 h', () => {
  const { g, clock } = make(DAILY);
  for (let i = 0; i < 3; i++) assert.equal(g.reserve(SEND).allowed, true);
  assert.match(g.reserve(SEND).reason, /daily send limit reached/);
  clock.advance(24 * 3600e3 + 1);
  assert.equal(g.reserve(SEND).allowed, true);
});

test('daily: failure count and failure-fee budget', () => {
  const { g } = make(DAILY);
  const a = g.reserve(SEND); g.recordFailure(a.id, { feePaid: 5000 });
  const b = g.reserve(SEND); g.recordFailure(b.id, { feePaid: 5000 });
  assert.match(g.reserve(SEND).reason, /daily failure limit reached/);
  const { g: g2 } = make({ ...DAILY, daily: { ...DAILY.daily, maxFailures: 10 } });
  const c = g2.reserve(SEND); g2.recordFailure(c.id, { feePaid: 5000 });
  const d = g2.reserve(SEND); g2.recordFailure(d.id, { feePaid: 5000 });
  assert.match(g2.reserve(SEND).reason, /failure-fee budget/, '10,000 paid + 5,000 more could fail > 12,000');
});

test('daily: outflow budget counts fee + tip + setup, released on failure', () => {
  const { g } = make({ ...DAILY, daily: { ...DAILY.daily, maxSends: 50, maxFailures: 50, maxFailureFees: sol(1), maxOutflow: sol(0.0025) } });
  const a = g.reserve(SEND); const b = g.reserve(SEND);
  assert.match(g.reserve(SEND).reason, /daily outflow budget/);
  g.recordFailure(a.id, { feePaid: 5000 });
  assert.equal(g.reserve(SEND).allowed, true, 'the released tip makes room again');
  void b;
});

test('checkpoint: halts when the balance would drop too far below the first-send balance', () => {
  const { g } = make({ ...DAILY, checkpoint: sol(0.05) });
  assert.equal(g.reserve(SEND).allowed, true);   // start balance 0.5 SOL
  const r = g.reserve({ ...SEND, balance: sol(0.45) });
  assert.match(r.reason, /checkpoint/);
  assert.equal(g.state.halted, true);
  assert.match(g.reserve({ ...SEND, balance: sol(1) }).reason, /^HALTED/);
});

test('halt / resume', () => {
  const { g } = make();
  g.halt('unexpected error 1234');
  assert.match(g.reserve(SEND).reason, /HALTED: unexpected error 1234/);
  g.resume();
  assert.equal(g.reserve(SEND).allowed, true);
});

test('state survives a restart', () => {
  const file = path.join(dir, 'restart.json');
  const { g } = make(BASE, file);
  for (let i = 0; i < 5; i++) g.reserve(SEND);
  const { g: again } = make(BASE, file);
  assert.match(again.reserve(SEND).reason, /lifetime send limit reached/);
});

test('an unreadable state file halts instead of starting from zero', () => {
  for (const bad of ['', '{"halted":', '{}', '{"version":1,"halted":false}']) {
    const file = path.join(dir, `bad${n++}.json`);
    fs.writeFileSync(file, bad);
    const { g } = make(BASE, file);
    assert.match(g.reserve(SEND).reason, /HALTED: state file .* unreadable/, JSON.stringify(bad));
  }
});

test('a send that cannot be saved is refused and the guard halts', () => {
  const { g } = make(BASE, path.join(dir, 'no-such-dir', 'state.json'));
  const r = g.reserve(SEND);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /could not save state/);
  assert.equal(g.state.totals.sends, 0, 'nothing recorded');
  assert.equal(g.state.halted, true);
});

test('concurrent callers cannot overshoot a limit', async () => {
  const { g } = make();
  const results = await Promise.all(Array.from({ length: 20 }, async () => { await null; return g.reserve(SEND); }));
  assert.equal(results.filter((r) => r.allowed).length, 5);
});
