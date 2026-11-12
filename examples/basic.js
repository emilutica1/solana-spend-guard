'use strict';
// Builds a transaction (never signed or sent), reads its fee and tip, and asks the guard. Run: node examples/basic.js
const { Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const { SpendGuard, sol, estimateTxFeeLamports, extractTipLamports, JITO_TIP_ACCOUNTS } = require('..');
const os = require('os');
const path = require('path');

const guard = new SpendGuard({
  stateFile: path.join(os.tmpdir(), 'spend-guard-example.json'),
  perTx: { maxFee: sol(0.001), maxTip: sol(0.005) },
  minReserve: sol(0.05),
  minProfitToCost: 3,
  daily: { maxSends: 40, maxFailures: 30, maxFailureFees: sol(0.01), maxOutflow: sol(0.1) },
  checkpoint: sol(0.05),
});

const payer = Keypair.generate().publicKey;
const tx = new VersionedTransaction(new TransactionMessage({
  payerKey: payer,
  recentBlockhash: '11111111111111111111111111111111',
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    // ... your instructions ...
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(JITO_TIP_ACCOUNTS[0]), lamports: 1_000_000 }),
  ],
}).compileToV0Message());

const fee = estimateTxFeeLamports(tx);    // 5,000 + 400,000 × 50,000 / 1e6 = 25,000
const tip = extractTipLamports(tx);       // 1,000,000
const r = guard.reserve({ fee, tip, profit: sol(0.02), balance: sol(0.5), label: 'example' });
console.log(`fee ${fee} L, tip ${tip} L →`, r);
if (r.allowed) {
  // sign and send here. If it then fails on-chain or never lands:
  guard.recordFailure(r.id, { feePaid: fee, reason: 'example: lost the race' });
}
console.log(guard.summary());
