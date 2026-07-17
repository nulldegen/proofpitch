# ProofPitch

**World Cup prediction pools that settle themselves — by cryptographic proof, not by a bookmaker.**

Entry for the TxODDS **Prediction Markets & Settlement** track — Superteam Earn World Cup Hackathon 2026.

## The idea

Every prediction market has the same weak point: whoever resolves the market.
An admin key, an oracle multisig, a "trusted" resolver — someone you must believe.

ProofPitch removes that party entirely:

1. **Stake** — users back YES or NO on a match predicate ("Over 2.5 goals",
   "France win", "Over 9.5 corners"). Stakes lock in a neutral escrow PDA of an
   on-chain program. There is no house and no counterparty risk.
2. **Prove** — TxODDS publishes Merkle roots of every score statistic on Solana
   every 5 minutes (the TxLINE oracle). After the final whistle, *anyone* — our
   keeper bot, a user, a bystander — fetches the Merkle proof from the TxLINE
   API and submits it to the escrow program.
3. **Settle** — the program CPIs into TxLINE's `validate_stat` instruction,
   which re-hashes the proof against the on-chain root and evaluates the market
   predicate `stat_a (+/- stat_b) {>,<,=} threshold` **entirely on-chain**.
   The escrow only ever acts on a TRUE answer: the YES side proves the market
   predicate, the NO side proves its integer negation. A false answer or an
   invalid proof settles nothing.
4. **Collect** — winners claim a pro-rata share of the whole pot straight from
   the escrow. If no proof can ever exist (abandoned fixture), stakes become
   refundable after a timeout. No admin key exists at any step.

## Live

- **App:** _deployment link in the submission_
- **Escrow program (devnet):** `F67iF8GhvpJSmoPRNqTR7ZXHXAkGEruAdzcP4ntdLp7R`
- **TxLINE oracle (devnet):** `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- **Demo video:** link in the hackathon submission

## Trust model

| You must trust | You do NOT need to trust |
|---|---|
| TxODDS' signed Merkle roots (the data layer itself) | ProofPitch — the operator cannot move, freeze, or misroute funds |
| Solana consensus | The keeper — settlement is permissionless; any proof-holder can settle |
| | The frontend — every action is verifiable in the Explorer |

## Architecture

```
TxLINE API (REST + SSE)                          Solana devnet
  ├─ /fixtures/snapshot ──────────┐                ┌──────────────────────────┐
  ├─ /odds/stream (SSE) ──────────┤                │ txoracle (TxODDS)        │
  ├─ /scores/stream (SSE) ────────┤                │  · daily_scores_roots PDA│
  └─ /scores/stat-validation ─────┤                │  · validate_stat         │
        (Merkle proofs)           │                └───────────▲──────────────┘
                                  ▼                            │ CPI
                        ProofPitch server                      │
                        (feeds → market engine                 │
                         → keeper)            ┌────────────────┴─────────────┐
                                  │           │ proofpitch escrow program    │
   Browser (dashboard,            ├──────────▶│  create_market · join        │
   Phantom staking,               │  txs      │  settle (proof) · claim      │
   receipts UI)  ◀── WS/API ──────┘           │  void_market (timeout refund)│
                                              └──────────────────────────────┘
```

- **Escrow program** ([program/src/lib.rs](program/src/lib.rs)) — ~450 lines of
  Anchor. Markets are PDAs storing the predicate spec; stakes live in the
  market account itself; `settle` verifies fixture id, stat keys, the finalised
  period (100), the predicate (or its negation for NO), the canonical
  daily-roots PDA for the proof's epoch day — then CPIs into `validate_stat`
  and demands TRUE.
- **Market engine** ([src/engine.ts](src/engine.ts)) — auto-opens seven standard
  markets per World Cup fixture, tracks live implied probabilities from the
  odds stream, and settles everything the moment the scores stream reports
  `game_finalised`.
- **Receipts** — every settlement stores the full proof payload and the
  transaction signature; the UI shows exactly what was proven, with Explorer
  links.

## Markets per fixture

| Market | On-chain predicate |
|---|---|
| Home win (90') | goals(P1) − goals(P2) > 0 |
| Draw (90') | goals(P1) − goals(P2) = 0 |
| Away win (90') | goals(P2) − goals(P1) > 0 |
| Over 2.5 goals | goals(P1) + goals(P2) > 2 |
| Goal before half-time | H1 goals(P1) + H1 goals(P2) > 0 |
| Over 9.5 corners | corners(P1) + corners(P2) > 9 |
| Over 4.5 yellow cards | yellows(P1) + yellows(P2) > 4 |

(TxLINE stat keys: 1/2 goals, 3/4 yellows, 7/8 corners; +1000 = first half.
The NO side settles by proving the integer negation — e.g. NO on "sum > 2"
proves "sum < 3" on-chain.)

## TxLINE endpoints used

| Purpose | Endpoint |
|---|---|
| Guest session | `POST {origin}/auth/guest/start` |
| Subscription (on-chain) | `txoracle.subscribe(level, weeks)` — free tier, devnet |
| Token activation | `POST {api}/token/activate` |
| Fixtures | `GET {api}/fixtures/snapshot` |
| Odds (live) | `SSE {api}/odds/stream` — implied probabilities from `Pct` |
| Scores (live) | `SSE {api}/scores/stream` — lifecycle + settlement trigger |
| Score history | `GET {api}/scores/historical/{fixtureId}` — finalised-record seq |
| **Merkle proofs** | `GET {api}/scores/stat-validation?fixtureId&seq&statKey&statKey2` |
| On-chain validation | `txoracle.validate_stat` — via CPI from our escrow program |

Auth on every data call: `Authorization: Bearer <guest JWT>` + `X-Api-Token: <activated token>`.

## Running it

```bash
npm install
npm start           # live devnet feeds + on-chain markets, dashboard on :4100
npm test            # offline deterministic checks (no network, no chain)
npm run probe       # end-to-end proof-of-primitive: fetches a real Merkle proof
                    # for a finished fixture and calls validate_stat on-chain
npm run rehearse    # full lifecycle on devnet against a finished fixture:
                    # create_market -> join YES/NO -> settle with the real
                    # Merkle proof (CPI validate_stat) -> claim the winnings
```

First run: a burner keypair is generated, registered with TxLINE's free tier
on-chain, and the API token is cached in `data/`. Devnet SOL only — zero real
funds anywhere.

The program was built and deployed with [Solana Playground](https://beta.solpg.io);
the exact source is committed in [program/src/lib.rs](program/src/lib.rs) and the
generated IDL in [idl/proofpitch.json](idl/proofpitch.json).

## Determinism & safety

- Settlement logic is a pure function of the proof payload — the same proof
  always produces the same outcome, off-chain and on-chain.
- The program never trusts a FALSE oracle answer (indistinguishable from a bad
  proof); outcomes are only ever set on TRUE.
- Stats must carry `period == 100` (the finalised record) — an in-play proof
  cannot settle a market early.
- The daily-roots account is re-derived inside the program from the proof's own
  batch timestamp; a forged roots account is rejected.
- Claims use u128 pro-rata math, floor-rounded — payouts can never exceed the pot.
- `npm test`: offline checks covering predicates, negation, PDAs, instruction
  encoding and the TxLINE feed quirks we hit (PascalCase live fields, StatusId
  phases, SSE-shaped history endpoints, sparse score cells).

## Status

- [x] TxLINE auth + live feeds (odds, scores, fixtures)
- [x] validate_stat proven end-to-end from TS (`npm run probe`)
- [x] Escrow program: create/join/settle-via-CPI/claim/void
- [x] Auto-market engine + keeper settlement
- [x] Broadcast dashboard + Phantom staking + proof receipts
- [x] Full lifecycle rehearsed on devnet — France v Spain (0-2, Jul 14):
      create → stake both sides → settle NO via on-chain proof → claim
      (`npm run rehearse`; the receipt is visible in the dashboard)
- [ ] Public deployment
- [ ] Demo video
- [ ] Submission on Superteam Earn (deadline July 19, 23:59 UTC)

## Author

Built solo by [@nulldegen](https://github.com/nulldegen) — independent developer,
autonomous agents and verifiable on-chain systems.

**Stack:** TypeScript · Node.js · Rust (Anchor) · @solana/web3.js · SSE · Express + WebSocket

Contact: kickfusion86@gmail.com

## License

All rights reserved. The code is public so judges and anyone else can audit the
settlement logic and verify the on-chain record; it is not licensed for reuse
or resubmission.
