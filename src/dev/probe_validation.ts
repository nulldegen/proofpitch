/**
 * End-to-end de-risk probe for the settlement primitive.
 *
 * Flow: TxLINE auth → historical scores for a FINISHED fixture → pick the
 * game_finalised record's seq → fetch the Merkle proof from
 * /scores/stat-validation (statKey=1 home goals, statKey2=2 away goals) →
 * derive the daily_scores_roots PDA → call txoracle.validate_stat via .view()
 * with predicates that must come out true AND false.
 *
 * If both answers are correct, the entire trustless-settlement design works.
 *
 * Usage: npm run probe [-- <fixtureId>]
 */
import fs from 'node:fs';
import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import { Connection, PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { getSession, loadKeypair, loadIdl } from '../auth.js';
import { FeedClient, ScoresStatValidation, ProofNodeJson, parseScoreHistory } from '../feed.js';
import { NET } from '../config.js';

const FIXTURE_ID = Number(process.argv[2] ?? 18237038); // France vs Spain, SF, finished Jul 14

/** Decode a JSON-encoded 32-byte hash (base64 or hex or number[]). */
export function decode32(h: unknown): number[] {
  if (Array.isArray(h)) {
    if (h.length !== 32) throw new Error(`hash array len ${h.length}`);
    return h as number[];
  }
  const s = String(h);
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Array.from(Buffer.from(s, 'hex'));
  const b = Buffer.from(s, 'base64');
  if (b.length === 32) return Array.from(b);
  throw new Error(`cannot decode hash: ${s.slice(0, 40)} (base64 gave ${b.length} bytes)`);
}

export function proofNodes(nodes: ProofNodeJson[]): { hash: number[]; isRightSibling: boolean }[] {
  return nodes.map(n => ({ hash: decode32(n.hash), isRightSibling: n.isRightSibling }));
}

async function main() {
  const session = await getSession();
  console.log(`[probe] session ok — wallet ${session.wallet} on ${session.network}`);
  const feed = new FeedClient(session);

  // 1. find the finalised score record
  const history = parseScoreHistory(await feed.scoresHistorical(FIXTURE_ID));
  console.log(`[probe] ${history.length} historical score records for fixture ${FIXTURE_ID}`);
  if (!history.length) throw new Error('no score history — pick another fixture');
  const finals = history.filter(r =>
    String(r.Action ?? r.action ?? '').toLowerCase() === 'game_finalised'
    || Number(r.StatusId ?? 0) >= 100);
  const rec = (finals.length ? finals : history)[ (finals.length ? finals : history).length - 1 ];
  const seq = Number(rec.Seq ?? rec.seq);
  console.log(`[probe] using seq=${seq} action=${rec.Action ?? rec.action} statusId=${rec.StatusId}`);
  console.log(`[probe] raw record: ${JSON.stringify(rec).slice(0, 400)}`);

  // 2. fetch the validation proof for home+away goals
  const v: ScoresStatValidation = await feed.statValidation(FIXTURE_ID, seq, 1, 2);
  fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync('./data/probe_validation.json', JSON.stringify(v, null, 1));
  console.log('[probe] proof payload saved to data/probe_validation.json');
  console.log(`[probe] statToProve  = ${JSON.stringify(v.statToProve)}`);
  console.log(`[probe] statToProve2 = ${JSON.stringify(v.statToProve2)}`);
  console.log(`[probe] ts=${v.ts} minTs=${v.summary?.updateStats?.minTimestamp} proofs: stat=${v.statProof?.length} stat2=${v.statProof2?.length} sub=${v.subTreeProof?.length} main=${v.mainTreeProof?.length}`);
  if (!v.statToProve2) throw new Error('no second stat in response — need statKey2=2 for two-stat predicates');

  // 3. on-chain view via txoracle.validate_stat
  const kp = loadKeypair();
  const connection = new Connection(NET.rpcUrl, 'confirmed');
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const idl = await loadIdl(connection, wallet);
  const program = new anchor.Program(idl as anchor.Idl, provider);

  // "Derive the epoch day from the exact timestamp in the proof response,
  //  never from Date.now()" — docs. minTimestamp is in ms.
  const targetTs = Number(v.summary.updateStats.minTimestamp);
  const epochDay = Math.floor(targetTs / 86_400_000);
  const [dailyScoresPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('daily_scores_roots'), new BN(epochDay).toArrayLike(Buffer, 'le', 2)],
    new PublicKey(NET.oracleProgramId),
  );
  console.log(`[probe] epochDay=${epochDay} dailyScoresPda=${dailyScoresPda.toBase58()}`);
  const pdaInfo = await connection.getAccountInfo(dailyScoresPda);
  if (!pdaInfo) throw new Error('daily scores roots PDA does not exist for that day — wrong epochDay derivation?');
  console.log(`[probe] PDA exists, ${pdaInfo.data.length} bytes, owner ${pdaInfo.owner.toBase58()}`);

  const summary = {
    fixtureId: new BN(v.summary.fixtureId),
    updateStats: {
      updateCount: v.summary.updateStats.updateCount,
      minTimestamp: new BN(v.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: decode32(v.summary.eventStatsSubTreeRoot),
  };
  const statA = {
    statToProve: { key: v.statToProve.key, value: v.statToProve.value, period: v.statToProve.period },
    eventStatRoot: decode32(v.eventStatRoot),
    statProof: proofNodes(v.statProof),
  };
  const statB = {
    statToProve: { key: v.statToProve2.key, value: v.statToProve2.value, period: v.statToProve2.period },
    eventStatRoot: decode32(v.eventStatRoot),
    statProof: proofNodes(v.statProof2!),
  };
  const fixtureProof = proofNodes(v.subTreeProof);
  const mainTreeProof = proofNodes(v.mainTreeProof);
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  const total = v.statToProve.value + v.statToProve2.value;
  const call = async (threshold: number, expect: boolean) => {
    const res: boolean = await (program.methods as any)
      .validateStat(
        new BN(v.ts),
        summary,
        fixtureProof,
        mainTreeProof,
        { threshold, comparison: { greaterThan: {} } },
        statA,
        statB,
        { add: {} },
      )
      .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
      .preInstructions([computeIx])
      .view();
    const ok = res === expect ? 'PASS' : 'FAIL';
    console.log(`[probe] validate_stat: goals_sum(${total}) > ${threshold} → ${res}  (expected ${expect})  ${ok}`);
    return res === expect;
  };

  const ok1 = await call(total - 1, true);   // e.g. total 3 → "sum > 2" must be TRUE
  const ok2 = await call(total, false);      // "sum > total" must be FALSE
  console.log(ok1 && ok2 ? '[probe] ALL GOOD — the settlement primitive works end-to-end' : '[probe] MISMATCH — inspect payload');
}

main().catch(e => {
  console.error('[probe] FAILED:', e?.message ?? e);
  if (e?.logs) console.error(e.logs.slice(-15).join('\n'));
  process.exit(1);
});
