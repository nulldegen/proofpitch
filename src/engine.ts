/**
 * ProofPitch engine — glues the TxLINE feeds to the on-chain escrow program.
 *
 * Responsibilities:
 *   - fixture registry (snapshot + defensive caching: some in-play fixtures
 *     never appear in /fixtures/snapshot, so names are also learned from odds)
 *   - live odds → implied probabilities per market (Pct fields)
 *   - live scores → market lifecycle (open → locked → settleable)
 *   - market auto-creation on-chain for upcoming fixtures
 *   - keeper: when a fixture finalises, fetch the Merkle proof and settle every
 *     open market for the TRUE side (YES or the proven negation for NO)
 *   - receipts: every settlement stores the full proof payload + tx signature
 */
import fs from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { FeedClient, RawFixture, RawOdds, RawScore, ScoreSummary, scoreSummary, parseScoreHistory, ScoresStatValidation } from './feed.js';
import { MarketSpec, standardMarkets, explainSpec, evaluate } from './markets.js';
import { PitchChain, ixSettle, marketPda, MarketAccount, STATE, SIDE_YES, SIDE_NO, PROGRAM_ID, exprValue } from './chain.js';

const WC_COMPETITION_ID = Number(process.env.WC_COMPETITION_ID ?? 72);
const REGISTRY_PATH = './data/markets.json';
const RECEIPTS_PATH = './data/receipts.json';
const NAMES_PATH = './data/fixture_names.json';

export interface FixtureInfo {
  fixtureId: number;
  p1: string;
  p2: string;
  startTime: number;      // ms
  competition: string;
}

export interface MarketView {
  address: string;
  code: string;
  label: string;
  explain: string;
  spec: MarketSpec;
  state: string;
  yesPool: number;        // lamports
  noPool: number;
  lockTs: number;         // sec
  impliedProb?: number;   // from live odds, when mapped
  settledTs?: number;
  receipt?: ReceiptRef;
}

export interface ReceiptRef {
  settleTx: string;
  side: 'yes' | 'no';
  provenPredicate: string;
  statValues: Record<string, number>;
  proofTs: number;
  validation: ScoresStatValidation;
}

interface RegistryEntry { fixtureId: number; code: string; address: string; id: string; }

export class Engine {
  fixtures = new Map<number, FixtureInfo>();
  scores = new Map<number, ScoreSummary>();
  /** implied probability per fixture per market code, from the odds stream */
  probs = new Map<number, Map<string, number>>();
  registry: RegistryEntry[] = [];
  markets = new Map<string, MarketAccount>();     // address → account
  receipts = new Map<string, ReceiptRef>();       // market address → receipt
  private settling = new Set<string>();
  onChange?: () => void;

  constructor(readonly feed: FeedClient, readonly chain: PitchChain) {
    this.registry = readJson<RegistryEntry[]>(REGISTRY_PATH, []);
    const rec = readJson<Record<string, ReceiptRef>>(RECEIPTS_PATH, {});
    for (const [k, v] of Object.entries(rec)) this.receipts.set(k, v);
    const names = readJson<Record<string, { p1: string; p2: string; startTime?: number; competition?: string }>>(NAMES_PATH, {});
    for (const [id, n] of Object.entries(names)) {
      this.fixtures.set(Number(id), {
        fixtureId: Number(id), p1: n.p1, p2: n.p2,
        startTime: n.startTime ?? 0, competition: n.competition ?? 'FIFA World Cup',
      });
    }
  }

  // ── fixtures ──────────────────────────────────────────────────────────────

  async loadFixtures(): Promise<void> {
    const rows = await this.feed.fixtures();
    for (const f of rows) this.learnFixture(f);
    this.persistNames();
  }

  learnFixture(f: RawFixture): void {
    if (f.CompetitionId !== WC_COMPETITION_ID) return;
    const ms = f.StartTime > 1e12 ? f.StartTime : f.StartTime * 1000;
    this.fixtures.set(f.FixtureId, {
      fixtureId: f.FixtureId,
      p1: f.Participant1, p2: f.Participant2,
      startTime: ms, competition: f.Competition,
    });
  }

  private persistNames(): void {
    const out: Record<string, unknown> = {};
    for (const [id, fx] of this.fixtures) out[id] = { p1: fx.p1, p2: fx.p2, startTime: fx.startTime, competition: fx.competition };
    writeJson(NAMES_PATH, out);
  }

  // ── odds → implied probabilities ──────────────────────────────────────────

  onOdds(raw: RawOdds): void {
    const fx = this.fixtures.get(raw.FixtureId);
    if (!fx) return;
    let m = this.probs.get(raw.FixtureId);
    if (!m) { m = new Map(); this.probs.set(raw.FixtureId, m); }
    const params = String(raw.MarketParameters ?? '');
    for (const spec of standardMarkets(fx.p1, fx.p2)) {
      const om = spec.oddsMarket;
      if (!om || om.superOddsType !== raw.SuperOddsType) continue;
      if (om.line && !params.includes(`line=${om.line}`)) continue;
      const idx = (raw.PriceNames ?? []).indexOf(om.outcome);
      if (idx < 0) continue;
      const cell = (raw.Pct ?? [])[idx];
      if (cell == null || cell === 'NA') continue;
      let p = Number(cell);
      if (!Number.isFinite(p) || p <= 0) continue;
      if (p > 1) p /= 100;
      if (p < 1) m.set(spec.code, p);
    }
  }

  // ── scores → lifecycle ────────────────────────────────────────────────────

  onScore(raw: RawScore, summary: ScoreSummary): void {
    const id = Number(summary.matchId);
    if (!this.fixtures.has(id)) return;   // not a WC fixture we know
    const prev = this.scores.get(id);
    if (prev && prev.seq > summary.seq) return;
    // Not every record repeats the Score cells — carry the last known scoreline.
    if (!summary.goals && prev?.goals) summary.goals = prev.goals;
    this.scores.set(id, summary);
    if (summary.etFinal) void this.settleFixture(id).catch(e => console.error(`[engine] settle ${id}:`, e.message));
  }

  // ── market creation ───────────────────────────────────────────────────────

  /** Create the standard on-chain markets for every known upcoming fixture. */
  async ensureMarkets(): Promise<void> {
    const now = Date.now();
    for (const fx of this.fixtures.values()) {
      if (!fx.startTime || fx.startTime < now) continue;       // only future fixtures
      for (const spec of standardMarkets(fx.p1, fx.p2)) {
        if (this.registry.find(r => r.fixtureId === fx.fixtureId && r.code === spec.code)) continue;
        // Deterministic market id: fixtureId * 100 + spec index keeps ids unique per creator.
        const specIdx = standardMarkets(fx.p1, fx.p2).findIndex(s => s.code === spec.code);
        const id = BigInt(fx.fixtureId) * 100n + BigInt(specIdx);
        const lockSec = Math.floor(fx.startTime / 1000);
        try {
          const sig = await this.chain.createMarket(id, fx.fixtureId, spec, lockSec);
          const address = marketPda(this.chain.payer.publicKey, id).toBase58();
          this.registry.push({ fixtureId: fx.fixtureId, code: spec.code, address, id: id.toString() });
          writeJson(REGISTRY_PATH, this.registry);
          console.log(`[engine] market created ${fx.p1} v ${fx.p2} "${spec.label}" → ${address} (${sig.slice(0, 16)}…)`);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes('already in use')) {
            const address = marketPda(this.chain.payer.publicKey, id).toBase58();
            this.registry.push({ fixtureId: fx.fixtureId, code: spec.code, address, id: id.toString() });
            writeJson(REGISTRY_PATH, this.registry);
          } else {
            console.error(`[engine] createMarket failed (${spec.code}): ${msg.slice(0, 120)}`);
          }
        }
      }
    }
    await this.refreshMarkets();
  }

  async refreshMarkets(): Promise<void> {
    try {
      const all = await this.chain.allMarkets();
      for (const m of all) this.markets.set(m.address, m);
      this.onChange?.();
    } catch (e) {
      console.error('[engine] refreshMarkets:', (e as Error).message.slice(0, 120));
    }
  }

  // ── settlement (the keeper) ───────────────────────────────────────────────

  /** Fetch proof for the finalised record and settle every open market of the fixture. */
  async settleFixture(fixtureId: number): Promise<void> {
    const entries = this.registry.filter(r => r.fixtureId === fixtureId);
    if (!entries.length) return;

    for (const entry of entries) {
      const acc = this.markets.get(entry.address);
      if (acc && acc.state !== 0) continue;          // already settled/void
      if (this.settling.has(entry.address)) continue;
      this.settling.add(entry.address);
      try {
        await this.settleMarket(entry);
      } catch (e) {
        console.error(`[engine] settle ${entry.code}@${fixtureId}: ${(e as Error).message.slice(0, 160)}`);
      } finally {
        this.settling.delete(entry.address);
      }
    }
    await this.refreshMarkets();
  }

  async settleMarket(entry: RegistryEntry): Promise<ReceiptRef> {
    const fx = this.fixtures.get(entry.fixtureId);
    if (!fx) throw new Error('unknown fixture');
    const spec = standardMarkets(fx.p1, fx.p2).find(s => s.code === entry.code);
    if (!spec) throw new Error('unknown spec ' + entry.code);

    // 1. locate the finalised record's seq (fallback across score endpoints)
    const history = await this.feed.finalisedHistory(entry.fixtureId);
    const finals = history.map(r => scoreSummary(r)).filter(s => s.etFinal);
    if (!finals.length) throw new Error('no finalised record yet');
    const seq = finals[finals.length - 1].seq;

    // 2. fetch the Merkle proof for exactly the stats this market needs
    const v = await this.feed.statValidation(entry.fixtureId, seq, spec.statKeyA, spec.statKeyB || undefined);

    // 3. which side is true? (off-chain evaluation mirrors the on-chain predicate)
    const yes = evaluate(spec, v.statToProve.value, v.statToProve2?.value ?? 0);
    const side = yes ? SIDE_YES : SIDE_NO;

    // 4. settle on-chain — the program CPIs into validate_stat and only
    //    accepts the outcome if the oracle answers TRUE
    const market = new PublicKey(entry.address);
    const sig = await this.chain.settle(market, spec, side, v);

    const receipt: ReceiptRef = {
      settleTx: sig,
      side: yes ? 'yes' : 'no',
      provenPredicate: explainSpec(spec, fx.p1, fx.p2) + (yes ? '' : '  [negation proven]'),
      statValues: {
        [String(v.statToProve.key)]: v.statToProve.value,
        ...(v.statToProve2 ? { [String(v.statToProve2.key)]: v.statToProve2.value } : {}),
      },
      proofTs: Number(v.ts),
      validation: v,
    };
    this.receipts.set(entry.address, receipt);
    writeJson(RECEIPTS_PATH, Object.fromEntries(this.receipts));
    console.log(`[engine] SETTLED ${fx.p1} v ${fx.p2} "${spec.label}" → ${receipt.side.toUpperCase()} (${sig.slice(0, 16)}…)`);
    this.onChange?.();
    return receipt;
  }

  // ── views for the API/frontend ────────────────────────────────────────────

  view() {
    const fixtures = [...this.fixtures.values()]
      .sort((a, b) => a.startTime - b.startTime)
      .map(fx => {
        const score = this.scores.get(fx.fixtureId);
        const probs = this.probs.get(fx.fixtureId);
        const markets: MarketView[] = this.registry
          .filter(r => r.fixtureId === fx.fixtureId)
          .map(r => {
            const acc = this.markets.get(r.address);
            const spec = standardMarkets(fx.p1, fx.p2).find(s => s.code === r.code)!;
            return {
              address: r.address,
              code: r.code,
              label: spec.label,
              explain: explainSpec(spec, fx.p1, fx.p2),
              spec,
              state: acc ? STATE[acc.state] : 'open',
              yesPool: acc ? Number(acc.yesPool) : 0,
              noPool: acc ? Number(acc.noPool) : 0,
              lockTs: acc ? acc.lockTs : Math.floor(fx.startTime / 1000),
              impliedProb: probs?.get(r.code),
              settledTs: acc?.settledTs || undefined,
              receipt: this.receipts.get(r.address),
            };
          });
        return { ...fx, score, markets };
      });
    return {
      programId: PROGRAM_ID.toBase58(),
      wallet: this.chain.payer.publicKey.toBase58(),
      fixtures,
    };
  }
}

// ── tiny json persistence helpers ───────────────────────────────────────────

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJson(path: string, value: unknown): void {
  fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value, null, 1));
}
