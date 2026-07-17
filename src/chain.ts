/**
 * On-chain client for the ProofPitch escrow program + settlement proof plumbing.
 *
 * Encoding is hand-rolled borsh against the program's IDL (idl/proofpitch.json).
 * Anchor conventions: instruction discriminator = sha256("global:<snake_name>")[0..8],
 * account discriminator = sha256("account:<Name>")[0..8], little-endian integers.
 */
import { createHash } from 'node:crypto';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { NET } from './config.js';
import { ScoresStatValidation, ProofNodeJson } from './feed.js';
import { MarketSpec, OP_CODE, CMP_CODE, Cmp, negation } from './markets.js';

export const PROGRAM_ID = new PublicKey(
  process.env.ESCROW_PROGRAM_ID || 'F67iF8GhvpJSmoPRNqTR7ZXHXAkGEruAdzcP4ntdLp7R',
);
export const TXORACLE = new PublicKey(NET.oracleProgramId);

export const SIDE_YES = 1;
export const SIDE_NO = 2;
export const STATE = ['open', 'settled_yes', 'settled_no', 'void'] as const;

const disc = (ns: string, name: string): Buffer =>
  createHash('sha256').update(`${ns}:${name}`).digest().subarray(0, 8);

// ── Borsh writer ────────────────────────────────────────────────────────────

class W {
  private chunks: Buffer[] = [];
  u8(v: number) { const b = Buffer.alloc(1); b.writeUInt8(v); this.chunks.push(b); return this; }
  u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.chunks.push(b); return this; }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.chunks.push(b); return this; }
  i32(v: number) { const b = Buffer.alloc(4); b.writeInt32LE(v); this.chunks.push(b); return this; }
  u64(v: bigint | number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.chunks.push(b); return this; }
  i64(v: bigint | number) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); this.chunks.push(b); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  bytes(v: Uint8Array) { this.chunks.push(Buffer.from(v)); return this; }
  str(v: string) { const b = Buffer.from(v, 'utf8'); this.u32(b.length); this.chunks.push(b); return this; }
  out(): Buffer { return Buffer.concat(this.chunks); }
}

// ── Proof payload helpers (shared with the probe) ───────────────────────────

/** Decode a JSON-encoded 32-byte hash (base64 / hex / number[]). */
export function decode32(h: unknown): Buffer {
  if (Array.isArray(h)) {
    if (h.length !== 32) throw new Error(`hash array len ${h.length}`);
    return Buffer.from(h);
  }
  const s = String(h);
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  if (b.length === 32) return b;
  throw new Error(`cannot decode hash: ${s.slice(0, 40)}`);
}

function writeProofVec(w: W, nodes: ProofNodeJson[]) {
  w.u32(nodes.length);
  for (const n of nodes) { w.bytes(decode32(n.hash)); w.bool(n.isRightSibling); }
}

function writeStatTerm(w: W, stat: { key: number; value: number; period: number }, eventStatRoot: unknown, proof: ProofNodeJson[]) {
  w.u32(stat.key).i32(stat.value).i32(stat.period);
  w.bytes(decode32(eventStatRoot));
  writeProofVec(w, proof);
}

const CMP_VARIANT: Record<Cmp, number> = { gt: 0, lt: 1, eq: 2 }; // GreaterThan, LessThan, EqualTo
const OP_VARIANT: Record<'add' | 'sub', number> = { add: 0, sub: 1 }; // Add, Subtract

// ── PDAs ────────────────────────────────────────────────────────────────────

export function marketPda(creator: PublicKey, id: bigint | number): PublicKey {
  const idBuf = Buffer.alloc(8); idBuf.writeBigUInt64LE(BigInt(id));
  return PublicKey.findProgramAddressSync([Buffer.from('market'), creator.toBuffer(), idBuf], PROGRAM_ID)[0];
}

export function positionPda(market: PublicKey, owner: PublicKey, side: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pos'), market.toBuffer(), owner.toBuffer(), Buffer.from([side])], PROGRAM_ID)[0];
}

/** txoracle daily scores roots PDA; epoch day derived from a ms timestamp. */
export function dailyScoresRootsPda(minTimestampMs: number): PublicKey {
  const epochDay = Math.floor(minTimestampMs / 86_400_000);
  const dayBuf = Buffer.alloc(2); dayBuf.writeUInt16LE(epochDay);
  return PublicKey.findProgramAddressSync([Buffer.from('daily_scores_roots'), dayBuf], TXORACLE)[0];
}

// ── Instructions ────────────────────────────────────────────────────────────

export function ixCreateMarket(
  creator: PublicKey, id: bigint | number, fixtureId: number, spec: MarketSpec, lockTsSec: number,
): TransactionInstruction {
  const w = new W();
  w.bytes(disc('global', 'create_market'));
  w.u64(id).i64(fixtureId).u32(spec.statKeyA).u32(spec.statKeyB)
    .u8(OP_CODE[spec.op]).u8(CMP_CODE[spec.cmp]).i32(spec.threshold).i64(lockTsSec).str(spec.label);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: marketPda(creator, id), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: w.out(),
  });
}

export function ixJoin(user: PublicKey, market: PublicKey, side: number, lamports: bigint | number): TransactionInstruction {
  const w = new W();
  w.bytes(disc('global', 'join')).u8(side).u64(lamports);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: positionPda(market, user, side), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: w.out(),
  });
}

/**
 * Build the settle instruction for `side` out of a TxLINE validation payload.
 * For YES the market predicate itself is proven; for NO its integer negation.
 * The caller must pass a validation payload fetched with statKey=market.statKeyA
 * (and statKey2=market.statKeyB when two-stat).
 */
export function ixSettle(market: PublicKey, spec: MarketSpec, side: number, v: ScoresStatValidation): TransactionInstruction {
  const pred = side === SIDE_YES
    ? { cmp: spec.cmp, threshold: spec.threshold }
    : negation(spec.cmp, spec.threshold, exprValue(spec, v));

  const w = new W();
  w.bytes(disc('global', 'settle'));
  w.u8(side);
  w.i64(v.ts);
  // summary
  w.i64(v.summary.fixtureId).i32(v.summary.updateStats.updateCount)
    .i64(v.summary.updateStats.minTimestamp).i64(v.summary.updateStats.maxTimestamp)
    .bytes(decode32(v.summary.eventStatsSubTreeRoot));
  writeProofVec(w, v.subTreeProof);   // fixture_proof
  writeProofVec(w, v.mainTreeProof);  // main_tree_proof
  w.i32(pred.threshold).u8(CMP_VARIANT[pred.cmp]); // predicate
  writeStatTerm(w, v.statToProve, v.eventStatRoot, v.statProof); // stat_a
  if (spec.statKeyB !== 0) {
    if (!v.statToProve2 || !v.statProof2) throw new Error('two-stat market but validation has no second stat');
    w.u8(1); writeStatTerm(w, v.statToProve2, v.eventStatRoot, v.statProof2);
    w.u8(1); w.u8(OP_VARIANT[spec.op as 'add' | 'sub']);
  } else {
    w.u8(0); // stat_b = None
    w.u8(0); // op = None
  }
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: dailyScoresRootsPda(Number(v.summary.updateStats.minTimestamp)), isSigner: false, isWritable: false },
      { pubkey: TXORACLE, isSigner: false, isWritable: false },
    ],
    data: w.out(),
  });
}

export function ixVoidMarket(market: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [{ pubkey: market, isSigner: false, isWritable: true }],
    data: disc('global', 'void_market'),
  });
}

export function ixClaim(user: PublicKey, market: PublicKey, side: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: positionPda(market, user, side), isSigner: false, isWritable: true },
    ],
    data: disc('global', 'claim'),
  });
}

/** Off-chain value of the market expression given the validation payload. */
export function exprValue(spec: MarketSpec, v: ScoresStatValidation): number {
  const a = v.statToProve.value;
  const b = v.statToProve2?.value ?? 0;
  return spec.statKeyB === 0 ? a : spec.op === 'add' ? a + b : a - b;
}

// ── Account decoding ────────────────────────────────────────────────────────

export interface MarketAccount {
  address: string;
  creator: string;
  id: bigint;
  fixtureId: number;
  statKeyA: number;
  statKeyB: number;
  op: number;
  cmp: number;
  threshold: number;
  lockTs: number;
  yesPool: bigint;
  noPool: bigint;
  state: number;
  settledTs: number;
  proofTs: number;
  label: string;
}

export const MARKET_DISC = disc('account', 'Market');
export const POSITION_DISC = disc('account', 'Position');

export function decodeMarket(address: PublicKey, data: Buffer): MarketAccount {
  if (!data.subarray(0, 8).equals(MARKET_DISC)) throw new Error('not a Market account');
  let o = 8;
  const creator = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const id = data.readBigUInt64LE(o); o += 8;
  const fixtureId = Number(data.readBigInt64LE(o)); o += 8;
  const statKeyA = data.readUInt32LE(o); o += 4;
  const statKeyB = data.readUInt32LE(o); o += 4;
  const op = data.readUInt8(o); o += 1;
  const cmp = data.readUInt8(o); o += 1;
  const threshold = data.readInt32LE(o); o += 4;
  const lockTs = Number(data.readBigInt64LE(o)); o += 8;
  const yesPool = data.readBigUInt64LE(o); o += 8;
  const noPool = data.readBigUInt64LE(o); o += 8;
  const state = data.readUInt8(o); o += 1;
  const settledTs = Number(data.readBigInt64LE(o)); o += 8;
  const proofTs = Number(data.readBigInt64LE(o)); o += 8;
  const labelLen = data.readUInt32LE(o); o += 4;
  const label = data.subarray(o, o + labelLen).toString('utf8'); o += labelLen;
  return {
    address: address.toBase58(), creator: creator.toBase58(), id, fixtureId,
    statKeyA, statKeyB, op, cmp, threshold, lockTs, yesPool, noPool, state, settledTs, proofTs, label,
  };
}

export interface PositionAccount {
  address: string;
  market: string;
  owner: string;
  side: number;
  amount: bigint;
  claimed: boolean;
}

export function decodePosition(address: PublicKey, data: Buffer): PositionAccount {
  if (!data.subarray(0, 8).equals(POSITION_DISC)) throw new Error('not a Position account');
  let o = 8;
  const market = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const owner = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const side = data.readUInt8(o); o += 1;
  const amount = data.readBigUInt64LE(o); o += 8;
  const claimed = data.readUInt8(o) === 1;
  return { address: address.toBase58(), market: market.toBase58(), owner: owner.toBase58(), side, amount, claimed };
}

// ── High-level client ───────────────────────────────────────────────────────

export class PitchChain {
  readonly connection: Connection;
  constructor(readonly payer: Keypair, rpcUrl: string = NET.rpcUrl) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  async send(ixs: TransactionInstruction[], computeUnits?: number): Promise<string> {
    const tx = new Transaction();
    if (computeUnits) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
    for (const ix of ixs) tx.add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [this.payer], { commitment: 'confirmed' });
  }

  createMarket(id: bigint | number, fixtureId: number, spec: MarketSpec, lockTsSec: number) {
    return this.send([ixCreateMarket(this.payer.publicKey, id, fixtureId, spec, lockTsSec)]);
  }

  join(market: PublicKey, side: number, lamports: bigint | number) {
    return this.send([ixJoin(this.payer.publicKey, market, side, lamports)]);
  }

  settle(market: PublicKey, spec: MarketSpec, side: number, v: ScoresStatValidation) {
    return this.send([ixSettle(market, spec, side, v)], 1_400_000);
  }

  claim(market: PublicKey, side: number) {
    return this.send([ixClaim(this.payer.publicKey, market, side)]);
  }

  voidMarket(market: PublicKey) {
    return this.send([ixVoidMarket(market)]);
  }

  async allMarkets(): Promise<MarketAccount[]> {
    const accs = await this.connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ memcmp: { offset: 0, bytes: bs58encode(MARKET_DISC) } }],
    });
    return accs.map(a => decodeMarket(a.pubkey, Buffer.from(a.account.data)));
  }

  async positionsOf(owner: PublicKey): Promise<PositionAccount[]> {
    const accs = await this.connection.getProgramAccounts(PROGRAM_ID, {
      filters: [
        { memcmp: { offset: 0, bytes: bs58encode(POSITION_DISC) } },
        { memcmp: { offset: 8 + 32, bytes: owner.toBase58() } },
      ],
    });
    return accs.map(a => decodePosition(a.pubkey, Buffer.from(a.account.data)));
  }
}

// tiny local base58 (no extra dep use at runtime beyond web3's)
import bs58 from 'bs58';
function bs58encode(b: Buffer): string { return bs58.encode(b); }
