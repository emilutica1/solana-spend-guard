'use strict';
const fs = require('fs');
const { writeFileAtomicSync } = require('./atomic');

const LAMPORTS_PER_SOL = 1_000_000_000;
const DAY_MS = 86_400_000;
const sol = (x) => Math.round(x * LAMPORTS_PER_SOL);
const fmt = (l) => `${(l / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
const amount = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const COSTS = ['fee', 'tip', 'protocolFee', 'setup'];

/**
 * A fail-closed spending limiter for bots that send real Solana transactions.
 *
 * Every limit must be configured explicitly; anything missing or zero refuses. All amounts are lamports (use `sol()`).
 * Four kinds of cost are tracked and capped separately, because they behave differently:
 *   fee          network fee (signatures + priority fee), paid even when the transaction fails on-chain
 *   tip          Jito (or other) tip; reverts with the transaction if it fails
 *   protocolFee  a fee the protocol itself charges in SOL, every time
 *   setup        one-time rent for accounts the transaction creates; reverts if it fails
 *
 * Usage: `const r = guard.reserve({...})` right before signing. It checks and, if allowed, records the send in the same
 * synchronous call (no await in between), so concurrent callers can never both slip under a cap. Then report the
 * outcome: `guard.recordFailure(r.id, { feePaid })` if it lost or never landed, `guard.halt(reason)` if something
 * unexpected happened. A landed success needs no call.
 */
class SpendGuard {
  constructor(config = {}) {
    if (!config.stateFile) throw new Error('SpendGuard: stateFile is required');
    this.stateFile = config.stateFile;
    this.now = config.now || (() => Date.now());
    this.log = config.log || ((level, msg) => (level === 'error' ? console.error : console.log)(`[SpendGuard] ${msg}`));
    const perTx = config.perTx || {};
    this.perTx = { fee: perTx.maxFee || 0, tip: perTx.maxTip || 0, protocolFee: perTx.maxProtocolFee || 0, setup: perTx.maxSetup || 0 };
    this.minReserve = config.minReserve;            // lamports that must stay in the wallet after the send
    this.minProfitToCost = config.minProfitToCost;  // 3 = expected profit must be ≥ 3× the cost; 0 = no profit check
    this.tipShare = config.tipOutsideRatio ? config.tipOutsideRatio.maxTipShareOfProfit : null;
    const lt = config.lifetime;
    this.lifetime = lt ? { sends: lt.maxSends || 0, fee: lt.maxFee || 0, tip: lt.maxTip || 0, protocolFee: lt.maxProtocolFee || 0, setup: lt.maxSetup || 0 } : null;
    const d = config.daily;
    this.daily = d ? { sends: d.maxSends || 0, failures: d.maxFailures || 0, failureFees: d.maxFailureFees || 0, outflow: d.maxOutflow || 0 } : null;
    this.checkpoint = config.checkpoint || 0;       // halt if the balance would fall this far below the first-send balance
    this.state = this.load();
  }

  // ---------- persistence ----------
  fresh(halted = false, reason = null) {
    return { version: 1, halted, haltedReason: reason, haltedAt: halted ? this.now() : null, startedAt: this.now(),
      startBalance: null, nextId: 1, totals: { sends: 0, fee: 0, tip: 0, protocolFee: 0, setup: 0 }, events: [] };
  }

  load() {
    // No file = a new session. A file that exists but cannot be trusted means the real counters are unknown → halt.
    if (!fs.existsSync(this.stateFile)) return this.fresh();
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const ok = s && s.version === 1 && typeof s.halted === 'boolean' && s.totals && Array.isArray(s.events)
        && ['sends', ...COSTS].every((k) => Number.isFinite(s.totals[k]));
      if (!ok) throw new Error('missing or invalid fields');
      return s;
    } catch (e) {
      const reason = `state file ${this.stateFile} is unreadable (${e.message}); inspect it, then delete it to start over`;
      this.log('error', `HALTED: ${reason}`);
      return this.fresh(true, reason);
    }
  }

  save() {
    try { writeFileAtomicSync(this.stateFile, JSON.stringify(this.state, null, 2)); return true; } catch (e) {
      this.state.halted = true; this.state.haltedReason = `could not save state: ${e.message}`; this.state.haltedAt = this.now();
      this.log('error', `HALTED: ${this.state.haltedReason}`);
      return false;
    }
  }

  // ---------- checks ----------
  window() {
    const since = this.now() - DAY_MS;
    this.state.events = this.state.events.filter((e) => e.t > since);
    const sends = this.state.events.filter((e) => e.kind === 'send'), fails = this.state.events.filter((e) => e.kind === 'fail');
    return { sends: sends.length, failures: fails.length, failureFees: fails.reduce((a, e) => a + e.fee, 0),
      outflow: sends.reduce((a, e) => a + COSTS.reduce((b, k) => b + e[k], 0), 0) };
  }

  /** Read-only: would this send be allowed? Same rules as reserve(), records nothing. */
  check(req) {
    const s = this.state;
    if (s.halted) return { allowed: false, reason: `HALTED: ${s.haltedReason}` };
    const c = { fee: amount(req.fee), tip: amount(req.tip), protocolFee: amount(req.protocolFee), setup: amount(req.setup) };
    const outflow = COSTS.reduce((a, k) => a + c[k], 0);
    const balance = req.balance;

    if (!(this.perTx.fee > 0)) return no('perTx.maxFee is not configured');
    if (!Number.isFinite(this.minReserve) || this.minReserve < 0) return no('minReserve is not configured');
    if (!Number.isFinite(this.minProfitToCost) || this.minProfitToCost < 0) return no('minProfitToCost is not configured (use 0 to turn the profit check off)');
    if (!this.lifetime && !this.daily) return no('no budget configured (lifetime and/or daily)');
    if (!(c.fee > 0)) return no('fee estimate missing (it is never zero; use estimateTxFeeLamports)');
    if (!Number.isFinite(balance)) return no('current balance missing');

    for (const k of COSTS) {
      if (c[k] > this.perTx[k]) return no(`${k} ${c[k]} L exceeds the per-transaction cap ${this.perTx[k]} L${this.perTx[k] ? '' : ` (perTx.max${cap(k)} not configured)`}`);
    }
    if (balance - outflow < this.minReserve) return no(`would leave ${fmt(balance - outflow)}, below the ${fmt(this.minReserve)} reserve`);

    if (this.minProfitToCost > 0) {
      if (!Number.isFinite(req.profit)) return no('expected profit missing (needed for the profit check)');
      let base = outflow;
      if (this.tipShare !== null) {
        if (!(this.tipShare > 0)) return no('tipOutsideRatio.maxTipShareOfProfit must be > 0');
        if (c.tip > req.profit * this.tipShare) return no(`tip ${c.tip} L is more than ${this.tipShare * 100}% of the expected profit ${Math.round(req.profit)} L`);
        base -= c.tip;
      }
      if (req.profit < base * this.minProfitToCost) return no(`expected profit ${Math.round(req.profit)} L is less than ${this.minProfitToCost}× the cost ${base} L`);
    }

    if (this.lifetime) {
      const t = s.totals, L = this.lifetime;
      if (!(L.sends > 0) || !(L.fee > 0)) return no('lifetime.maxSends and lifetime.maxFee must both be configured');
      if (t.sends >= L.sends) return no(`lifetime send limit reached (${t.sends}/${L.sends})`);
      for (const k of COSTS) {
        if (c[k] > 0 && t[k] + c[k] > L[k]) return no(`lifetime ${k} budget would be exceeded (${t[k]} + ${c[k]} > ${L[k]} L)`);
      }
    }
    if (this.daily) {
      const D = this.daily;
      if (!(D.sends > 0 && D.failures > 0 && D.failureFees > 0 && D.outflow > 0)) return no('daily.maxSends, maxFailures, maxFailureFees and maxOutflow must all be configured');
      const w = this.window();
      if (w.sends >= D.sends) return no(`daily send limit reached (${w.sends}/${D.sends} in 24 h)`);
      if (w.failures >= D.failures) return no(`daily failure limit reached (${w.failures}/${D.failures} in 24 h)`);
      if (w.failureFees + c.fee > D.failureFees) return no(`daily failure-fee budget would be exceeded if this one fails (${w.failureFees} + ${c.fee} > ${D.failureFees} L)`);
      if (w.outflow + outflow > D.outflow) return no(`daily outflow budget would be exceeded (${w.outflow} + ${outflow} > ${D.outflow} L)`);
    }
    if (this.checkpoint > 0 && s.startBalance !== null && s.startBalance - (balance - outflow) > this.checkpoint) {
      return no(`checkpoint: balance would fall more than ${fmt(this.checkpoint)} below the starting ${fmt(s.startBalance)}`, true);
    }
    return { allowed: true, costs: c, outflow };
  }

  /** Check and, if allowed, record the send atomically. Returns { allowed, reason } or { allowed: true, id }. */
  reserve(req) {
    const r = this.check(req);
    if (!r.allowed) {
      if (r.haltOnRefuse) { this.halt(r.reason); }
      return { allowed: false, reason: r.reason };
    }
    const s = this.state, id = s.nextId++;
    const firstBalance = s.startBalance === null;
    if (firstBalance) s.startBalance = req.balance;
    s.events.push({ id, t: this.now(), kind: 'send', ...r.costs, label: String(req.label || '').slice(0, 80) });
    s.totals.sends++;
    for (const k of COSTS) s.totals[k] += r.costs[k];
    if (!this.save()) {   // not on disk → a restart would forget it; refuse rather than send unrecorded
      s.events.pop(); s.totals.sends--; for (const k of COSTS) s.totals[k] -= r.costs[k];
      if (firstBalance) s.startBalance = null;
      return { allowed: false, reason: this.state.haltedReason };
    }
    return { allowed: true, id };
  }

  /**
   * The send `id` lost on-chain or never landed. `feePaid` = the network fee actually charged (0 if it never landed).
   * A failed transaction does not pay its tip or setup rent (they revert with it), so those are released from the
   * totals; a send that never landed releases its fee too. Counts toward the daily failure limits; does not halt.
   */
  recordFailure(id, { feePaid = 0, reason = '' } = {}) {
    const s = this.state, e = s.events.find((x) => x.id === id && x.kind === 'send');
    const paid = amount(feePaid);
    if (e && !e.released) {
      for (const k of ['tip', 'setup']) { s.totals[k] -= e[k]; e[k] = 0; }
      const unpaid = Math.max(0, e.fee - paid);   // the estimate is replaced by what was really charged
      s.totals.fee -= unpaid; e.fee -= unpaid;
      e.released = true;
    } else if (!e) {
      this.log('warn', `recordFailure(${id}): send not found (older than 24 h or unknown); counted as a failure anyway`);
    }
    s.events.push({ id, t: this.now(), kind: 'fail', fee: paid, tip: 0, protocolFee: 0, setup: 0, label: String(reason).slice(0, 80) });
    this.save();
  }

  /** Stop everything until resume() or the state file is deleted. Call it on any outcome you did not expect. */
  halt(reason) {
    this.state.halted = true; this.state.haltedReason = String(reason); this.state.haltedAt = this.now();
    this.save();
    this.log('error', `HALTED: ${reason}`);
  }

  /** Clear a halt after you have looked into it. Totals and the daily window are kept. */
  resume() {
    this.state.halted = false; this.state.haltedReason = null; this.state.haltedAt = null;
    this.save();
  }

  summary() {
    const t = this.state.totals, parts = [this.state.halted ? `HALTED (${this.state.haltedReason})` : 'active'];
    if (this.lifetime) parts.push(`lifetime sends ${t.sends}/${this.lifetime.sends}, fees ${fmt(t.fee)}/${fmt(this.lifetime.fee)}, tips ${fmt(t.tip)}`);
    if (this.daily) { const w = this.window(); parts.push(`24 h sends ${w.sends}/${this.daily.sends}, failures ${w.failures}/${this.daily.failures}, outflow ${fmt(w.outflow)}/${fmt(this.daily.outflow)}`); }
    return parts.join(' | ');
  }
}

function no(reason, haltOnRefuse = false) { return { allowed: false, reason, haltOnRefuse }; }
function cap(k) { return k === 'protocolFee' ? 'ProtocolFee' : k[0].toUpperCase() + k.slice(1); }

module.exports = { SpendGuard, sol, LAMPORTS_PER_SOL };
