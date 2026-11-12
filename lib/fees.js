'use strict';
// Read what a built (unsigned or signed) VersionedTransaction will cost, from the transaction itself rather than from a
// separate guess. Works on @solana/web3.js v1 VersionedTransaction objects.

const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5000;
const MAX_COMPUTE_UNITS = 1_400_000;
const DEFAULT_CU_PER_INSTRUCTION = 200_000;

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
// Signature-verification precompiles: the runtime charges the base fee for every signature they verify, on top of the
// transaction's own signers. The first data byte of each such instruction is its signature count.
const PRECOMPILES = new Set([
  'KeccakSecp256k11111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
  'Secp256r1SigVerify1111111111111111111111111',
]);

// The 8 Jito tip accounts (verified on-chain against Jito's documentation, 2026).
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const key = (k) => (k && typeof k.toBase58 === 'function' ? k.toBase58() : undefined);

/**
 * Network fee in lamports: base fee per signature (including signatures verified by precompiles) plus the priority
 * fee, computed from the compute-unit limit and price set in the transaction's own ComputeBudget instructions.
 * Without a SetComputeUnitLimit instruction the limit is taken as 200,000 per other instruction (max 1.4M), the
 * runtime default for non-builtin programs; for builtins that over-counts, which is the safe side for a spending cap.
 */
function estimateTxFeeLamports(tx) {
  const msg = tx.message;
  const keys = msg.staticAccountKeys || [];
  const ixs = msg.compiledInstructions || [];
  let signatures = (msg.header && msg.header.numRequiredSignatures) || (tx.signatures && tx.signatures.length) || 1;
  let cuLimit = null, cuPriceMicroLamports = 0n, other = 0;
  for (const ix of ixs) {
    const program = key(keys[ix.programIdIndex]);
    const data = Buffer.from(ix.data || []);
    if (PRECOMPILES.has(program)) { if (data.length >= 1) signatures += data.readUInt8(0); other++; continue; }
    if (program !== COMPUTE_BUDGET_PROGRAM) { other++; continue; }
    if (data[0] === 2 && data.length >= 5) cuLimit = data.readUInt32LE(1);              // SetComputeUnitLimit
    else if (data[0] === 3 && data.length >= 9) cuPriceMicroLamports = data.readBigUInt64LE(1);   // SetComputeUnitPrice
  }
  if (cuLimit === null) cuLimit = Math.min(MAX_COMPUTE_UNITS, DEFAULT_CU_PER_INSTRUCTION * Math.max(1, other));
  const priority = (BigInt(cuLimit) * cuPriceMicroLamports + 999_999n) / 1_000_000n;   // rounded up
  return signatures * BASE_FEE_LAMPORTS_PER_SIGNATURE + Number(priority);
}

/**
 * Lamports the transaction tips: every System Program transfer to one of `tipAccounts` (default: Jito's 8). A transfer
 * whose destination comes from an address lookup table cannot be resolved without fetching the table, so it is
 * counted as a tip too (over-counting is the safe side for a spending cap).
 */
function extractTipLamports(tx, tipAccounts = JITO_TIP_ACCOUNTS) {
  const tips = new Set(tipAccounts.map((a) => (typeof a === 'string' ? a : key(a))));
  const msg = tx.message;
  const keys = msg.staticAccountKeys || [];
  let total = 0;
  for (const ix of msg.compiledInstructions || []) {
    if (key(keys[ix.programIdIndex]) !== SYSTEM_PROGRAM) continue;
    const data = Buffer.from(ix.data || []);
    if (data.length < 12 || data.readUInt32LE(0) !== 2) continue;   // 2 = Transfer
    const destIndex = ix.accountKeyIndexes && ix.accountKeyIndexes[1];
    if (destIndex === undefined) continue;
    const dest = destIndex < keys.length ? key(keys[destIndex]) : undefined;   // undefined = from a lookup table
    if (dest === undefined || tips.has(dest)) total += Number(data.readBigUInt64LE(4));
  }
  return total;
}

module.exports = { estimateTxFeeLamports, extractTipLamports, JITO_TIP_ACCOUNTS, BASE_FEE_LAMPORTS_PER_SIGNATURE };
