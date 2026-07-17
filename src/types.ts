/** Shared domain types. */

/** One outcome's implied probability at one moment, from one bookmaker. */
export interface OddsPoint {
  ts: number;            // ms
  matchId: string;
  market: string;        // e.g. "1X2_PARTICIPANT_RESULT half=full @Consensus"
  outcome: string;       // e.g. "part1" | "draw" | "part2" | "over" | "under"
  decimalOdds: number;   // 1 / impliedProb
}
