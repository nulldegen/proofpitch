/**
 * TxLINE data feed client — fixtures, odds, scores (REST), live SSE streams,
 * and the Merkle validation-proof endpoints that power trustless settlement.
 *
 * Contract (TxLINE OpenAPI):
 *   - Base: {apiBaseUrl} = https://txline[-dev].txodds.com/api
 *   - Every data endpoint needs BOTH headers together:
 *       Authorization: Bearer <guestJwt>
 *       X-Api-Token:   <apiToken>
 *   - Streaming is Server-Sent Events: GET /odds/stream, GET /scores/stream.
 *     Optional ?fixtureId= filter, Last-Event-ID resume, heartbeat keep-alives.
 *
 * Casing is load-bearing and inconsistent in the API: Fixtures & Odds use
 * PascalCase (Ts, FixtureId, PriceNames…); the live Scores feed also sends
 * PascalCase even though the OpenAPI document says camelCase. Both accepted.
 */
import axios from 'axios';
import { NET, NetConfig } from './config.js';
import { OddsPoint } from './types.js';

// ── Raw API payloads (verbatim from TxLINE) ─────────────────────────────────

export interface RawFixture {
  Ts: number;
  StartTime: number;
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  FixtureId: number;
  Participant1IsHome: boolean;
}

export interface RawOdds {
  FixtureId: number;
  MessageId: string;
  Ts: number;
  Bookmaker: string;
  BookmakerId: number;
  SuperOddsType: string;
  GameState?: string;
  InRunning: boolean;
  MarketParameters?: string;
  MarketPeriod?: string;
  PriceNames: string[];
  Prices: number[];   // integer fixed-point encoding — kept raw
  Pct: string[];      // implied % per price; 3-decimal string OR the literal 'NA'
}

export interface RawScore {
  fixtureId?: number;
  gameState?: string;
  startTime?: number;
  ts?: number;
  seq?: number;
  action?: string;
  competitionId?: number;
  sportId?: number;
  confirmed?: boolean;
  // live feed spelling
  FixtureId?: number;
  GameState?: string;
  StartTime?: number;
  Ts?: number;
  Seq?: number;
  Action?: string;
  StatusId?: number;
  Confirmed?: boolean;
  Clock?: { Running?: boolean; Seconds?: number };
  Score?: unknown;      // cumulative per-participant score cells (sparse)
  [k: string]: unknown;
}

// ── Validation-proof payloads (GET /scores/stat-validation etc.) ────────────
// Binary fields arrive JSON-encoded; exact encoding (base64) confirmed by probe.

export interface ProofNodeJson { hash: string; isRightSibling: boolean; }
export interface ScoreStatJson { key: number; value: number; period: number; }
export interface ScoresUpdateStatsJson { updateCount: number; minTimestamp: number; maxTimestamp: number; }
export interface ScoresBatchSummaryJson {
  fixtureId: number;
  updateStats: ScoresUpdateStatsJson;
  eventStatsSubTreeRoot: string;
}

/** Legacy mode (statKey / statKey2): one or two provable stats. */
export interface ScoresStatValidation {
  ts: number;
  statToProve: ScoreStatJson;
  eventStatRoot: string;
  summary: ScoresBatchSummaryJson;
  statProof: ProofNodeJson[];
  subTreeProof: ProofNodeJson[];
  mainTreeProof: ProofNodeJson[];
  statToProve2?: ScoreStatJson;
  statProof2?: ProofNodeJson[];
}

/** V2 mode (statKeys=csv): N provable stats. */
export interface ScoresStatValidationV2 {
  ts: number;
  statsToProve: ScoreStatJson[];
  eventStatRoot: string;
  summary: ScoresBatchSummaryJson;
  statProofs: ProofNodeJson[][];
  subTreeProof: ProofNodeJson[];
  mainTreeProof: ProofNodeJson[];
}

export interface FeedAuth {
  jwt: string;
  apiToken: string;
}

// ── Normalization ───────────────────────────────────────────────────────────

/** epoch-seconds → ms; leaves ms untouched. */
const toMs = (ts: number): number => (ts > 0 && ts < 1e12 ? ts * 1000 : ts);

/**
 * Fan one odds payload out into per-outcome OddsPoints, driven by `Pct`
 * (the book's own implied %). decimalOdds = 1 / prob round-trips cleanly.
 */
export function oddsToPoints(raw: RawOdds): OddsPoint[] {
  const parts = [raw.SuperOddsType, raw.MarketPeriod, raw.MarketParameters].filter(Boolean);
  const market = `${parts.join(' ')} @${raw.Bookmaker}`.trim();
  const ts = toMs(raw.Ts);
  const names = raw.PriceNames ?? [];
  const pcts = raw.Pct ?? [];
  const n = Math.min(names.length, pcts.length);

  const out: OddsPoint[] = [];
  for (let i = 0; i < n; i++) {
    const cell = pcts[i];
    if (cell == null || cell === 'NA') continue;
    let prob = Number(cell);
    if (!Number.isFinite(prob) || prob <= 0) continue;
    if (prob > 1) prob = prob / 100;      // "47.600" percent → 0.476 fraction
    if (prob >= 1) continue;              // implausible certainty → skip
    out.push({
      ts,
      matchId: String(raw.FixtureId),
      market,
      outcome: names[i],
      decimalOdds: 1 / prob,
    });
  }
  return out;
}

/** Light score summary — enough to know a match's state without sport parsing. */
export interface ScoreSummary {
  matchId: string;
  ts: number;
  seq: number;
  gameState: string;
  action: string;
  statusId: number | null;
  finished: boolean;   // regulation is over — full-match markets can settle
  h1Final: boolean;    // halftime reached — first-half markets can settle
  etFinal: boolean;    // the whole game is over
  abandoned: boolean;
  goals: GoalsPair | null;  // live scoreline when the record carries Score cells
}

export interface GoalsPair { p1: number; p2: number }

// Score cells are cumulative and sparse: an existing period object with no
// Goals key means 0 for that period. Prefer per-period sums (incl. ET) over
// Total, which on this feed covers regulation only.
function cellGoals(p: unknown): number {
  if (!p || typeof p !== 'object') return 0;
  const c = p as Record<string, { Goals?: number } | undefined>;
  const periods = [c.H1?.Goals, c.H2?.Goals, c.ET1?.Goals, c.ET2?.Goals];
  if (periods.some(v => v != null)) return periods.reduce((a: number, v) => a + (v ?? 0), 0);
  return c.Total?.Goals ?? 0;
}

export function liveGoals(raw: RawScore): GoalsPair | null {
  const sc = raw.Score;
  if (!sc || typeof sc !== 'object') return null;
  const cells = sc as Record<string, unknown>;
  if (!('Participant1' in cells) && !('Participant2' in cells)) return null;
  return { p1: cellGoals(cells.Participant1), p2: cellGoals(cells.Participant2) };
}

// The live devnet feed keeps GameState at "scheduled" for the whole match and
// encodes the phase in StatusId instead. Observed vocabulary:
//   1 pre-match, 2 first half, 3 halftime, 4 second half,
//   5 full time (no extra time), 6 end of regulation before ET,
//   7 ET first half, 8 ET break, 9 ET second half, 100 game_finalised.
const FINISHED_STATES = new Set(['f', 'ft', 'fet', 'fpe', 'end', 'ended', 'final', 'finished']);
const HT_STATUS_ID = 3;
const REG_OVER_STATUS_ID = 5;
const FINALISED_STATUS_ID = 100;

export function scoreSummary(raw: RawScore): ScoreSummary {
  const gs = String(raw.GameState ?? raw.gameState ?? '').trim().toLowerCase();
  const action = String(raw.Action ?? raw.action ?? '').trim().toLowerCase();
  const sid = Number(raw.StatusId);
  const statusId = Number.isFinite(sid) ? sid : null;

  const legacyFinished = FINISHED_STATES.has(gs)
    || /(^|[^a-z])(ft|finished|ended|final|full[\s_-]?time)([^a-z]|$)/.test(gs);
  const etFinal = legacyFinished
    || action === 'game_finalised'
    || statusId === REG_OVER_STATUS_ID
    || (statusId !== null && statusId >= FINALISED_STATUS_ID);
  const finished = etFinal
    || (statusId !== null && statusId >= REG_OVER_STATUS_ID);
  return {
    matchId: String(raw.FixtureId ?? raw.fixtureId),
    ts: toMs(Number(raw.Ts ?? raw.ts)),
    seq: Number(raw.Seq ?? raw.seq ?? 0),
    gameState: String(raw.GameState ?? raw.gameState ?? ''),
    action,
    statusId,
    finished,
    h1Final: finished
      || action === 'halftime_finalised'
      || (statusId !== null && statusId >= HT_STATUS_ID),
    etFinal,
    abandoned: gs === 'a' || /aband|cancel|postpon/.test(gs) || /aband|cancel|postpon/.test(action),
    goals: liveGoals(raw),
  };
}

/**
 * /scores/updates/{fixtureId} answers with raw SSE text (`data: {...}` frames)
 * rather than a JSON array. Accept both.
 */
export function parseScoreHistory(payload: unknown): RawScore[] {
  if (Array.isArray(payload)) return payload as RawScore[];
  if (typeof payload !== 'string') return [];
  const rows: RawScore[] = [];
  for (const line of payload.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { rows.push(JSON.parse(line.slice(5).trim())); } catch { /* heartbeat / junk */ }
  }
  return rows;
}

// ── SSE plumbing ────────────────────────────────────────────────────────────

interface SseFrame { id?: string; event?: string; data: string; }

function parseSseFrame(text: string): SseFrame {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const c = line.indexOf(':');
    const field = c === -1 ? line : line.slice(0, c);
    let value = c === -1 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return { id, event, data: data.join('\n') };
}

export interface SseHandle { close(): void; }

export interface StreamOptions {
  fixtureId?: number | string;
  lastEventId?: string;
  maxBackoffMs?: number;
}

export interface OddsStreamHandlers {
  onOdds: (raw: RawOdds, points: OddsPoint[], meta: { id?: string }) => void;
  onHeartbeat?: (ts: number) => void;
  onError?: (err: Error, willRetry: boolean) => void;
  onOpen?: () => void;
}

export interface ScoreStreamHandlers {
  onScore: (raw: RawScore, summary: ScoreSummary, meta: { id?: string }) => void;
  onHeartbeat?: (ts: number) => void;
  onError?: (err: Error, willRetry: boolean) => void;
  onOpen?: () => void;
}

// ── Client ──────────────────────────────────────────────────────────────────

export class FeedClient {
  constructor(private auth: FeedAuth, private net: NetConfig = NET) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.auth.jwt}`,
      'X-Api-Token': this.auth.apiToken,
    };
  }

  private async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const res = await axios.get<T>(`${this.net.apiBaseUrl}${path}`, {
      headers: this.headers(),
      params,
      timeout: 20_000,
    });
    return res.data;
  }

  // Fixtures / schedule
  fixtures(opts: { startEpochDay?: number; competitionId?: number } = {}): Promise<RawFixture[]> {
    return this.get<RawFixture[]>('/fixtures/snapshot', opts);
  }

  // Odds
  oddsSnapshot(fixtureId: number | string, asOf?: number): Promise<RawOdds[]> {
    return this.get<RawOdds[]>(`/odds/snapshot/${fixtureId}`, asOf ? { asOf } : undefined);
  }
  oddsUpdates(fixtureId: number | string): Promise<RawOdds[]> {
    return this.get<RawOdds[]>(`/odds/updates/${fixtureId}`);
  }

  // Scores
  scoresSnapshot(fixtureId: number | string, asOf?: number): Promise<RawScore[]> {
    return this.get<RawScore[]>(`/scores/snapshot/${fixtureId}`, asOf ? { asOf } : undefined);
  }
  scoresUpdates(fixtureId: number | string): Promise<RawScore[]> {
    return this.get<RawScore[]>(`/scores/updates/${fixtureId}`);
  }
  /**
   * Score records containing a finalised entry, trying every endpoint.
   * The live feed populates them inconsistently: /historical can stay empty
   * for a fixture whose /updates and /snapshot both carry game_finalised
   * (observed on the bronze final after a stream "disconnected" action).
   */
  async finalisedHistory(fixtureId: number | string): Promise<RawScore[]> {
    for (const call of [this.scoresHistorical, this.scoresUpdates, this.scoresSnapshot]) {
      try {
        const recs = parseScoreHistory(await call.call(this, fixtureId));
        if (recs.some(r => scoreSummary(r).etFinal)) return recs;
      } catch { /* endpoint may 404 for this fixture — try the next one */ }
    }
    return [];
  }

  scoresHistorical(fixtureId: number | string): Promise<RawScore[]> {
    return this.get<RawScore[]>(`/scores/historical/${fixtureId}`);
  }

  // Merkle validation proofs — the settlement primitive.
  statValidation(fixtureId: number | string, seq: number, statKey: number, statKey2?: number): Promise<ScoresStatValidation> {
    const params: Record<string, unknown> = { fixtureId, seq, statKey };
    if (statKey2 != null) params.statKey2 = statKey2;
    return this.get<ScoresStatValidation>('/scores/stat-validation', params);
  }
  statValidationMulti(fixtureId: number | string, seq: number, statKeys: number[]): Promise<ScoresStatValidationV2> {
    return this.get<ScoresStatValidationV2>('/scores/stat-validation', {
      fixtureId, seq, statKeys: statKeys.join(','),
    });
  }

  // Live streams (SSE)
  streamOdds(handlers: OddsStreamHandlers, opts: StreamOptions = {}): SseHandle {
    return this.runStream<RawOdds>('/odds/stream', opts, {
      onData: (raw, meta) => handlers.onOdds(raw, oddsToPoints(raw), meta),
      onHeartbeat: handlers.onHeartbeat,
      onError: handlers.onError,
      onOpen: handlers.onOpen,
    });
  }

  streamScores(handlers: ScoreStreamHandlers, opts: StreamOptions = {}): SseHandle {
    return this.runStream<RawScore>('/scores/stream', opts, {
      onData: (raw, meta) => handlers.onScore(raw, scoreSummary(raw), meta),
      onHeartbeat: handlers.onHeartbeat,
      onError: handlers.onError,
      onOpen: handlers.onOpen,
    });
  }

  /** Generic SSE runner with auto-reconnect + Last-Event-ID resume. */
  private runStream<T>(
    path: string,
    opts: StreamOptions,
    h: {
      onData: (payload: T, meta: { id?: string }) => void;
      onHeartbeat?: (ts: number) => void;
      onError?: (err: Error, willRetry: boolean) => void;
      onOpen?: () => void;
    },
  ): SseHandle {
    const ctrl = new AbortController();
    let closed = false;
    let lastId = opts.lastEventId;
    const maxBackoff = opts.maxBackoffMs ?? 30_000;

    const loop = async () => {
      let backoff = 1_000;
      while (!closed) {
        try {
          const url = new URL(`${this.net.apiBaseUrl}${path}`);
          if (opts.fixtureId != null) url.searchParams.set('fixtureId', String(opts.fixtureId));
          const headers: Record<string, string> = {
            ...this.headers(),
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
          };
          if (lastId) headers['Last-Event-ID'] = lastId;

          const res = await fetch(url, { headers, signal: ctrl.signal });
          if (!res.ok || !res.body) throw new Error(`SSE ${path} → HTTP ${res.status}`);
          h.onOpen?.();
          backoff = 1_000;

          await this.pump(res.body as ReadableStream<Uint8Array>, (frame) => {
            if (frame.id) lastId = frame.id;
            if (frame.event === 'heartbeat') {
              let ts = Date.now();
              try { ts = Number(JSON.parse(frame.data)?.Ts) || ts; } catch { /* keep now */ }
              h.onHeartbeat?.(ts);
              return;
            }
            if (!frame.data) return;
            try {
              h.onData(JSON.parse(frame.data) as T, { id: frame.id });
            } catch (e) {
              h.onError?.(new Error(`bad SSE data: ${(e as Error).message}`), true);
            }
          });
          // server closed the stream cleanly → reconnect from lastId
        } catch (e) {
          if (closed || (e as Error).name === 'AbortError') break;
          h.onError?.(e as Error, true);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, maxBackoff);
        }
      }
    };
    void loop();
    return { close() { closed = true; ctrl.abort(); } };
  }

  private async pump(
    body: ReadableStream<Uint8Array>,
    onFrame: (f: SseFrame) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        onFrame(parseSseFrame(frame));
      }
    }
  }
}
