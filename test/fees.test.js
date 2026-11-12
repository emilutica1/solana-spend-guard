'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, TransactionInstruction } = require('@solana/web3.js');
const { estimateTxFeeLamports, extractTipLamports, JITO_TIP_ACCOUNTS } = require('..');

const payer = Keypair.generate().publicKey;
const blockhash = '11111111111111111111111111111111';
const build = (ixs) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
const memo = new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from('x') });

test('base fee only: 1 signature, no priority fee', () => {
  assert.equal(estimateTxFeeLamports(build([memo])), 5000);
});

test('priority fee = CU limit × price, rounded up', () => {
  const tx = build([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_001 }), memo]);
  assert.equal(estimateTxFeeLamports(tx), 5000 + Math.ceil(300_000 * 10_001 / 1e6));
});

test('without a CU limit: 200,000 per instruction is assumed (safe side)', () => {
  const tx = build([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }), memo, memo]);
  assert.equal(estimateTxFeeLamports(tx), 5000 + 400_000);
});

test('signatures verified by a precompile are charged too', () => {
  const ed = new TransactionInstruction({ programId: new PublicKey('Ed25519SigVerify111111111111111111111111111'), keys: [], data: Buffer.from([2, 0]) });
  assert.equal(estimateTxFeeLamports(build([ed, memo])), 3 * 5000);
});

test('tips: only transfers to tip accounts are counted', () => {
  const tx = build([
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(JITO_TIP_ACCOUNTS[3]), lamports: 1_000_000 }),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 7 }),
  ]);
  assert.equal(extractTipLamports(tx), 1_000_000);
  assert.equal(extractTipLamports(tx, []), 0);
});
