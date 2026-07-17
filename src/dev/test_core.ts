/**
 * Offline deterministic checks — no network, no chain.
 *   npm test
 */
import assert from 'node:assert';
import { PublicKey } from '@solana/web3.js';
import { standardMarkets, explainSpec, evaluate, negation } from '../markets.js';
import {
  decode32, marketPda, positionPda, dailyScoresRootsPda, ixCreateMarket, ixJoin, ixSettle,
  decodeMarket, MARKET_DISC, PROGRAM_ID, SIDE_YES, SIDE_NO,
} from '../chain.js';
import { scoreSummary, parseScoreHistory, oddsToPoints, RawOdds } from '../feed.js';

let passed = 0;
const ok = (cond: boolean, name: string) => {
  assert.ok(cond, name);
  passed++;
  console.log(`  ok - ${name}`);
};

// ── market specs ────────────────────────────────────────────────────────────
console.log('markets:');
{
  const specs = standardMarkets('France', 'Spain');
  ok(specs.length === 7, 'seven standard markets per fixture');
  ok(specs.every(s => Buffer.from(s.label, 'utf8').length <= 64, ), 'labels fit the on-chain 64-byte cap');
  const home = specs.find(s => s.code === 'home')!;
  ok(evaluate(home, 2, 1) && !evaluate(home, 1, 1) && !evaluate(home, 0, 2), 'home-win predicate: goals(P1)-goals(P2) > 0');
  const draw = specs.find(s => s.code === 'draw')!;
  ok(evaluate(draw, 1, 1) && !evaluate(draw, 2, 1), 'draw predicate: difference == 0');
  const o25 = specs.find(s => s.code === 'o25')!;
  ok(evaluate(o25, 2, 1) && !evaluate(o25, 1, 1), 'over 2.5: sum > 2');
  ok(explainSpec(home, 'France', 'Spain') === 'goals(France) - goals(Spain) > 0', 'explain renders the formula');
  const h1 = specs.find(s => s.code === 'o15h1')!;
  ok(h1.statKeyA === 1001 && h1.statKeyB === 1002, 'first-half keys use the 1000 period prefix');
}

// ── negation (what the NO side must prove) ──────────────────────────────────
console.log('negation:');
{
  ok(JSON.stringify(negation('gt', 2)) === JSON.stringify({ cmp: 'lt', threshold: 3 }), 'not(x>2) == x<3');
  ok(JSON.stringify(negation('lt', 3)) === JSON.stringify({ cmp: 'gt', threshold: 2 }), 'not(x<3) == x>2');
  ok(JSON.stringify(negation('eq', 0, -1)) === JSON.stringify({ cmp: 'lt', threshold: 0 }), 'not(x==0), x=-1 → x<0');
  ok(JSON.stringify(negation('eq', 0, 2)) === JSON.stringify({ cmp: 'gt', threshold: 0 }), 'not(x==0), x=2 → x>0');
}

// ── hashes / PDAs ───────────────────────────────────────────────────────────
console.log('chain encoding:');
{
  const b64 = Buffer.alloc(32, 7).toString('base64');
  ok(decode32(b64).equals(Buffer.alloc(32, 7)), 'decode32 handles base64');
  ok(decode32('ab'.repeat(32)).length === 32, 'decode32 handles hex');
  ok(decode32(Array(32).fill(1)).length === 32, 'decode32 handles number[]');

  // Known-good PDA from the live probe (France v Spain, epoch day 20648):
  const pda = dailyScoresRootsPda(1784063054751);
  ok(pda.toBase58() === 'FDU3RVD6u95iLNdVrTNpars2dM8XLyf1doNThPjY7ypm', 'daily_scores_roots PDA matches the live-verified derivation');

  const creator = new PublicKey('Bn6nrz9ja8rBsC45C39wrkAYM8wUx1B1BcWoGzLEL3fF');
  const m = marketPda(creator, 1823703800n);
  ok(PublicKey.isOnCurve(m.toBytes()) === false, 'market PDA is off-curve');
  const p = positionPda(m, creator, SIDE_YES);
  ok(!p.equals(positionPda(m, creator, SIDE_NO)), 'YES and NO positions derive different PDAs');
}

// ── instruction encoding ────────────────────────────────────────────────────
console.log('instructions:');
{
  const creator = new PublicKey('Bn6nrz9ja8rBsC45C39wrkAYM8wUx1B1BcWoGzLEL3fF');
  const spec = standardMarkets('A', 'B').find(s => s.code === 'o25')!;
  const ix = ixCreateMarket(creator, 5n, 123, spec, 1_700_000_000);
  ok(ix.programId.equals(PROGRAM_ID), 'create_market targets our program');
  ok(ix.keys.length === 3 && ix.keys[0].isSigner, 'create_market account order: creator, market, system');
  // discriminator + u64 + i64 + u32*2 + u8*2 + i32 + i64 + (4+label)
  ok(ix.data.length === 8 + 8 + 8 + 4 + 4 + 1 + 1 + 4 + 8 + 4 + Buffer.from(spec.label).length, 'create_market data length exact');

  const join = ixJoin(creator, ix.keys[1].pubkey, SIDE_NO, 50_000_000n);
  ok(join.data.length === 8 + 1 + 8, 'join data = disc + side + amount');
  ok(join.data.readUInt8(8) === 2 && join.data.readBigUInt64LE(9) === 50_000_000n, 'join encodes side and lamports LE');

  // settle built from a fabricated validation payload
  const h = (n: number) => Buffer.alloc(32, n).toString('base64');
  const v = {
    ts: 1784063054751,
    statToProve: { key: 1, value: 0, period: 100 },
    eventStatRoot: h(1),
    summary: {
      fixtureId: 18237038,
      updateStats: { updateCount: 3, minTimestamp: 1784063054751, maxTimestamp: 1784063054751 },
      eventStatsSubTreeRoot: h(2),
    },
    statProof: [{ hash: h(3), isRightSibling: true }],
    subTreeProof: [{ hash: h(4), isRightSibling: false }],
    mainTreeProof: [{ hash: h(5), isRightSibling: true }],
    statToProve2: { key: 2, value: 2, period: 100 },
    statProof2: [{ hash: h(6), isRightSibling: false }],
  };
  const homeSpec = standardMarkets('France', 'Spain').find(s => s.code === 'home')!;
  const settleNo = ixSettle(ix.keys[1].pubkey, homeSpec, SIDE_NO, v as never);
  ok(settleNo.data.readUInt8(8) === SIDE_NO, 'settle side encoded');
  // NO on (a-b > 0) proves (a-b < 1): threshold 1 LE + LessThan variant (=1)
  ok(settleNo.data.includes(Buffer.from([1, 0, 0, 0, 1])), 'NO predicate = threshold 1 + LessThan variant');
  const settleYes = ixSettle(ix.keys[1].pubkey, homeSpec, SIDE_YES, v as never);
  ok(settleYes.data.includes(Buffer.from([0, 0, 0, 0, 0])), 'YES predicate = threshold 0 + GreaterThan variant');
  ok(settleYes.keys[1].pubkey.equals(dailyScoresRootsPda(1784063054751)), 'settle passes the canonical daily roots PDA');
}

// ── market account decoding ─────────────────────────────────────────────────
console.log('account decode:');
{
  const buf = Buffer.alloc(300);
  MARKET_DISC.copy(buf, 0);
  const creator = new PublicKey('Bn6nrz9ja8rBsC45C39wrkAYM8wUx1B1BcWoGzLEL3fF');
  creator.toBuffer().copy(buf, 8);
  let o = 40;
  buf.writeBigUInt64LE(42n, o); o += 8;              // id
  buf.writeBigInt64LE(18237038n, o); o += 8;         // fixtureId
  buf.writeUInt32LE(1, o); o += 4;                   // statKeyA
  buf.writeUInt32LE(2, o); o += 4;                   // statKeyB
  buf.writeUInt8(1, o); o += 1;                      // op add
  buf.writeUInt8(0, o); o += 1;                      // cmp gt
  buf.writeInt32LE(2, o); o += 4;                    // threshold
  buf.writeBigInt64LE(1_800_000_000n, o); o += 8;    // lockTs
  buf.writeBigUInt64LE(111n, o); o += 8;             // yesPool
  buf.writeBigUInt64LE(222n, o); o += 8;             // noPool
  buf.writeUInt8(1, o); o += 1;                      // state settled_yes
  buf.writeBigInt64LE(0n, o); o += 8;                // settledTs
  buf.writeBigInt64LE(0n, o); o += 8;                // proofTs
  buf.writeUInt32LE(4, o); o += 4; buf.write('Over', o); o += 4; // label
  buf.writeUInt8(255, o);                            // bump
  const m = decodeMarket(creator, buf);
  ok(m.id === 42n && m.fixtureId === 18237038 && m.threshold === 2 && m.yesPool === 111n && m.label === 'Over', 'market account round-trips');
}

// ── feed encodings (regression-guard the TxLINE quirks) ─────────────────────
console.log('feed:');
{
  const s = scoreSummary({ FixtureId: 1, Ts: 1, Seq: 9, Action: 'game_finalised', StatusId: 100 });
  ok(s.etFinal && s.finished, 'game_finalised/StatusId 100 marks the match final');
  const live = scoreSummary({ FixtureId: 1, Ts: 1, Seq: 2, GameState: 'scheduled', StatusId: 4 });
  ok(!live.etFinal && !live.finished && live.h1Final, 'StatusId 4 (H2) is not final but H1 markets can settle');
  const hist = parseScoreHistory('data: {"Seq":1}\n\ndata: {"Seq":2}\n\n');
  ok(hist.length === 2 && hist[1].Seq === 2, 'raw SSE score history parses');
  const pts = oddsToPoints({
    FixtureId: 7, MessageId: 'x', Ts: 1000, Bookmaker: 'B', BookmakerId: 1, SuperOddsType: '1X2',
    InRunning: false, PriceNames: ['part1', 'draw', 'part2'], Prices: [0, 0, 0], Pct: ['47.6', 'NA', '30.0'],
  } as RawOdds);
  ok(pts.length === 2 && Math.abs(pts[0].decimalOdds - 1 / 0.476) < 1e-9, 'Pct percent cells → implied probabilities, NA skipped');
}

console.log(`\n${passed} checks passed`);
