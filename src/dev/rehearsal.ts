/**
 * Full-lifecycle rehearsal on devnet against a FINISHED fixture.
 *
 * create_market (lock in +150s) → join YES + join NO → fetch the Merkle proof
 * for the finalised record → settle (program CPIs txoracle.validate_stat) →
 * claim the winning side. Every step is a real transaction on the deployed
 * program — this is exactly what the keeper does when a live match finalises.
 *
 * The settled market is persisted into the registry/receipts files so the
 * dashboard shows a completed market with its verifiable receipt.
 *
 * Usage: npm run rehearse [-- <fixtureId>]   (default 18237038 France v Spain, finished Jul 14)
 */
import fs from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { getSession, loadKeypair } from '../auth.js';
import { FeedClient, ScoresStatValidation, parseScoreHistory, scoreSummary } from '../feed.js';
import { standardMarkets, explainSpec, evaluate } from '../markets.js';
import { PitchChain, marketPda, positionPda, SIDE_YES, SIDE_NO, STATE, decodeMarket, decodePosition } from '../chain.js';

const FIXTURE_ID = Number(process.argv[2] ?? 18237038);
const P1 = 'France';
const P2 = 'Spain';
const STAKE = 5_000_000; // 0.005 SOL per side

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const session = await getSession();
  const feed = new FeedClient(session);
  const kp = loadKeypair();
  const chain = new PitchChain(kp);
  const before = await chain.connection.getBalance(kp.publicKey);
  console.log(`[rehearsal] wallet ${kp.publicKey.toBase58()} — ${(before / 1e9).toFixed(4)} SOL`);

  // spec: Over 2.5 goals (two-stat add/gt — exercises the full predicate path)
  const spec = standardMarkets(P1, P2).find(s => s.code === 'o25')!;
  const id = BigInt(FIXTURE_ID) * 100n + 90n; // offset 90: never collides with engine ids (0..6)
  const market = marketPda(kp.publicKey, id);
  console.log(`[rehearsal] market "${spec.label}" on ${P1} v ${P2} (${FIXTURE_ID}) → ${market.toBase58()}`);

  // 1. create (lock 150s out so joins are legal)
  const lockTs = Math.floor(Date.now() / 1000) + 150;
  const existing = await chain.connection.getAccountInfo(market);
  if (!existing) {
    const sig = await chain.createMarket(id, FIXTURE_ID, spec, lockTs);
    console.log(`[rehearsal] 1. create_market  ${sig}`);
  } else {
    console.log('[rehearsal] 1. market already exists — continuing');
  }

  // 2. stake both sides (two positions, same wallet — allowed by design)
  const mAcc0 = decodeMarket(market, Buffer.from((await chain.connection.getAccountInfo(market))!.data));
  if (mAcc0.state !== 0) throw new Error(`market already ${STATE[mAcc0.state]} — pick a fresh id`);
  if (Number(mAcc0.yesPool) === 0) {
    const s1 = await chain.join(market, SIDE_YES, STAKE);
    console.log(`[rehearsal] 2a. join YES 0.005  ${s1}`);
  }
  if (Number(mAcc0.noPool) === 0) {
    const s2 = await chain.join(market, SIDE_NO, STAKE);
    console.log(`[rehearsal] 2b. join NO  0.005  ${s2}`);
  }

  // 3. the finalised record + its Merkle proof
  const history = parseScoreHistory(await feed.scoresHistorical(FIXTURE_ID));
  const finals = history.map(r => scoreSummary(r)).filter(s => s.etFinal);
  if (!finals.length) throw new Error('fixture not finalised');
  const seq = finals[finals.length - 1].seq;
  const v: ScoresStatValidation = await feed.statValidation(FIXTURE_ID, seq, spec.statKeyA, spec.statKeyB || undefined);
  const a = v.statToProve.value, b = v.statToProve2?.value ?? 0;
  console.log(`[rehearsal] 3. proof fetched (seq ${seq}): goals ${a}-${b}`);

  // 4. settle — YES if the predicate held, else NO via proven negation
  const yes = evaluate(spec, a, b);
  const side = yes ? SIDE_YES : SIDE_NO;
  const settleSig = await chain.settle(market, spec, side, v);
  console.log(`[rehearsal] 4. settle → ${yes ? 'YES' : 'NO'} (${a}+${b} vs > ${spec.threshold})  ${settleSig}`);

  // 5. claim the winning position (loser's stake is the winner's profit)
  const claimSig = await chain.claim(market, side);
  console.log(`[rehearsal] 5. claim ${yes ? 'YES' : 'NO'}  ${claimSig}`);

  await sleep(2000);
  const mAcc = decodeMarket(market, Buffer.from((await chain.connection.getAccountInfo(market))!.data));
  const pos = decodePosition(
    positionPda(market, kp.publicKey, side),
    Buffer.from((await chain.connection.getAccountInfo(positionPda(market, kp.publicKey, side)))!.data),
  );
  const after = await chain.connection.getBalance(kp.publicKey);
  console.log(`[rehearsal] market state=${STATE[mAcc.state]} pools YES=${Number(mAcc.yesPool) / 1e9} NO=${Number(mAcc.noPool) / 1e9} claimed=${pos.claimed}`);
  console.log(`[rehearsal] balance ${(before / 1e9).toFixed(4)} → ${(after / 1e9).toFixed(4)} SOL (Δ ${(after - before) / 1e9})`);

  // 6. persist for the dashboard: fixture name, registry entry, receipt
  const upsert = (path: string, mut: (o: any) => any) => {
    let cur: any; try { cur = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { cur = undefined; }
    fs.writeFileSync(path, JSON.stringify(mut(cur), null, 1));
  };
  upsert('./data/fixture_names.json', (o = {}) => ({
    ...o, [FIXTURE_ID]: o[FIXTURE_ID] ?? { p1: P1, p2: P2, startTime: Date.parse('2026-07-14T19:00:00Z'), competition: 'FIFA World Cup' },
  }));
  upsert('./data/markets.json', (o = []) => Array.isArray(o) && o.find((r: any) => r.address === market.toBase58())
    ? o
    : [...(o ?? []), { fixtureId: FIXTURE_ID, code: spec.code, address: market.toBase58(), id: id.toString() }]);
  upsert('./data/receipts.json', (o = {}) => ({
    ...o,
    [market.toBase58()]: {
      settleTx: settleSig,
      side: yes ? 'yes' : 'no',
      provenPredicate: explainSpec(spec, P1, P2) + (yes ? '' : '  [negation proven]'),
      statValues: { [String(v.statToProve.key)]: a, ...(v.statToProve2 ? { [String(v.statToProve2.key)]: b } : {}) },
      proofTs: Number(v.ts),
      validation: v,
    },
  }));
  console.log('[rehearsal] receipt + registry persisted — restart the server to see it in the dashboard');
  console.log('[rehearsal] ALL GOOD — full lifecycle (create/join/settle-with-proof/claim) verified on devnet');
}

main().catch(e => {
  console.error('[rehearsal] FAILED:', e?.message ?? e);
  if (e?.logs) console.error(e.logs.slice(-15).join('\n'));
  process.exit(1);
});
