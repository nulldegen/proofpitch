/**
 * Market catalog — which predicate markets ProofPitch opens per fixture, and
 * how each maps onto txoracle's validate_stat predicate model.
 *
 * A market is a binary YES/NO pool over one provable predicate:
 *   expr := statA | statA + statB | statA - statB      (TxLINE stat keys)
 *   P    := expr > t | expr < t | expr == t
 * YES wins if P holds in the finalised (period 100) record; NO wins otherwise
 * (proven on-chain via the integer negation of P).
 *
 * TxLINE soccer stat keys: 1/2 = P1/P2 goals, 3/4 yellows, 5/6 reds,
 * 7/8 corners. Period prefix on the key: 0 = full game, 1000 = 1st half,
 * 3000 = 2nd half (e.g. 1002 = 1st-half goals of participant 2).
 */

export type Op = 'none' | 'add' | 'sub';
export type Cmp = 'gt' | 'lt' | 'eq';

export interface MarketSpec {
  code: string;        // stable id within a fixture, e.g. "home", "o25"
  statKeyA: number;
  statKeyB: number;    // 0 = single-stat
  op: Op;
  cmp: Cmp;
  threshold: number;
  label: string;       // <= 64 bytes on-chain
  /** odds-feed mapping for implied probability display (optional) */
  oddsMarket?: { superOddsType: string; outcome: string; line?: string };
}

export const OP_CODE: Record<Op, number> = { none: 0, add: 1, sub: 2 };
export const CMP_CODE: Record<Cmp, number> = { gt: 0, lt: 1, eq: 2 };

/** The standard market set opened for every World Cup fixture. */
export function standardMarkets(p1: string, p2: string): MarketSpec[] {
  return [
    {
      code: 'home', statKeyA: 1, statKeyB: 2, op: 'sub', cmp: 'gt', threshold: 0,
      label: `${p1} win (90')`,
      oddsMarket: { superOddsType: '1X2_PARTICIPANT_RESULT', outcome: 'part1' },
    },
    {
      code: 'draw', statKeyA: 1, statKeyB: 2, op: 'sub', cmp: 'eq', threshold: 0,
      label: `Draw (90')`,
      oddsMarket: { superOddsType: '1X2_PARTICIPANT_RESULT', outcome: 'draw' },
    },
    {
      code: 'away', statKeyA: 2, statKeyB: 1, op: 'sub', cmp: 'gt', threshold: 0,
      label: `${p2} win (90')`,
      oddsMarket: { superOddsType: '1X2_PARTICIPANT_RESULT', outcome: 'part2' },
    },
    {
      code: 'o25', statKeyA: 1, statKeyB: 2, op: 'add', cmp: 'gt', threshold: 2,
      label: 'Over 2.5 goals',
      oddsMarket: { superOddsType: 'OVERUNDER_PARTICIPANT_GOALS', outcome: 'over', line: '2.5' },
    },
    {
      code: 'o15h1', statKeyA: 1001, statKeyB: 1002, op: 'add', cmp: 'gt', threshold: 0,
      label: 'Goal before half-time',
    },
    {
      code: 'corners95', statKeyA: 7, statKeyB: 8, op: 'add', cmp: 'gt', threshold: 9,
      label: 'Over 9.5 corners',
    },
    {
      code: 'cards45', statKeyA: 3, statKeyB: 4, op: 'add', cmp: 'gt', threshold: 4,
      label: 'Over 4.5 yellow cards',
    },
  ];
}

/** Human-readable formula, e.g. "goals(P1) - goals(P2) > 0". */
export function explainSpec(s: MarketSpec, p1: string, p2: string): string {
  const statName = (key: number): string => {
    const base = key % 1000;
    const period = key >= 1000 ? `H1 ` : '';
    const who = base % 2 === 1 ? p1 : p2;
    const what = base <= 2 ? 'goals' : base <= 4 ? 'yellow cards' : base <= 6 ? 'red cards' : 'corners';
    return `${period}${what}(${who})`;
  };
  const expr = s.statKeyB === 0
    ? statName(s.statKeyA)
    : `${statName(s.statKeyA)} ${s.op === 'add' ? '+' : '-'} ${statName(s.statKeyB)}`;
  const cmp = s.cmp === 'gt' ? '>' : s.cmp === 'lt' ? '<' : '=';
  return `${expr} ${cmp} ${s.threshold}`;
}

/**
 * The negated predicate the NO side must prove on-chain.
 *   not (x > t)  ==  x < t + 1
 *   not (x < t)  ==  x > t - 1
 *   not (x == t) ==  x > t  OR  x < t   (either one settles NO)
 * For 'eq' we pick the direction that is actually true given the stat values.
 */
export function negation(cmp: Cmp, threshold: number, actualValue?: number): { cmp: Cmp; threshold: number } {
  if (cmp === 'gt') return { cmp: 'lt', threshold: threshold + 1 };
  if (cmp === 'lt') return { cmp: 'gt', threshold: threshold - 1 };
  if (actualValue !== undefined && actualValue < threshold) return { cmp: 'lt', threshold };
  return { cmp: 'gt', threshold };
}

/** Evaluate the predicate off-chain (mirror of on-chain semantics, for the keeper/UI). */
export function evaluate(s: MarketSpec, valueA: number, valueB: number): boolean {
  const expr = s.statKeyB === 0 ? valueA : s.op === 'add' ? valueA + valueB : valueA - valueB;
  return s.cmp === 'gt' ? expr > s.threshold : s.cmp === 'lt' ? expr < s.threshold : expr === s.threshold;
}
