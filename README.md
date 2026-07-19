# ProofPitch

**World Cup prediction pools that settle themselves — by cryptographic proof, not by a bookmaker.**

Entry for the **Prediction Markets & Settlement** track — TxODDS World Cup Hackathon 2026, Superteam Earn.

- **Live application:** https://deletion-lettuce-fragrance.ngrok-free.dev
- **Escrow program (Solana devnet):** [`F67iF8GhvpJSmoPRNqTR7ZXHXAkGEruAdzcP4ntdLp7R`](https://explorer.solana.com/address/F67iF8GhvpJSmoPRNqTR7ZXHXAkGEruAdzcP4ntdLp7R?cluster=devnet)
- **TxLINE oracle (devnet):** `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- **Demo video:** linked in the hackathon submission

---

## Abstract

Every prediction market shares a single structural weakness: the party that
resolves it. Whether that party is an administrator key, an oracle multisig,
or a "trusted" resolver, users must ultimately believe that someone will
declare the correct outcome and release funds accordingly.

ProofPitch removes that party entirely. Markets are escrow accounts on Solana
whose funds can move for exactly one reason: a Merkle proof of the final match
statistics, published by TxODDS and verified **on-chain** by TxLINE's
`validate_stat` instruction, invoked by the escrow program itself. The
operator holds no privileged keys, settlement is permissionless, and every
outcome ships with a receipt that anyone can audit in the Solana Explorer.

The system ran unattended during the tournament's closing matches: at full
time of the third-place final (France 4–6 England, 18 July 2026), all seven
markets settled autonomously with real TxLINE proofs, and winning positions
were subsequently claimed — every transaction of that lifecycle is on devnet.

## Protocol lifecycle

1. **Stake.** Users back YES or NO on a match predicate ("Over 2.5 goals",
   "France win", "Over 9.5 corners"). Stakes lock in a neutral escrow PDA of
   the on-chain program. There is no house and no counterparty.
2. **Prove.** TxODDS anchors Merkle roots of every score statistic on Solana
   throughout the match. After the final whistle, any party — the keeper bot,
   a user, a bystander — fetches the corresponding Merkle proof from the
   TxLINE API and submits it to the escrow program.
3. **Settle.** The program performs a CPI into TxLINE's `validate_stat`,
   which re-hashes the proof against the anchored root and evaluates the
   predicate `stat_a (± stat_b) {>,<,=} threshold` entirely on-chain. The
   YES side settles by proving the market predicate; the NO side by proving
   its integer negation. A false answer or an invalid proof settles nothing.
4. **Collect.** Winners claim a pro-rata share of the full pot directly from
   the escrow. Should no proof ever exist (an abandoned fixture), stakes
   become refundable after a timeout. No administrator exists at any step.

## Trust model

| You must trust | You do **not** need to trust |
|---|---|
| TxODDS' signed Merkle roots (the data layer itself) | ProofPitch — the operator cannot move, freeze, or misroute funds |
| Solana consensus | The keeper — settlement is permissionless; any proof-holder can settle |
| | The frontend — every action is independently verifiable in the Explorer |

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

**Components**

- **Escrow program** ([program/src/lib.rs](program/src/lib.rs)) — ~450 lines
  of Anchor. Markets are PDAs storing the predicate specification; stakes are
  held by the market account itself. `settle` verifies the fixture id, the
  stat keys, the finalised period (`100`), the predicate (or its negation for
  the NO side) and the canonical daily-roots PDA for the proof's epoch day —
  then CPIs into `validate_stat` and requires a TRUE answer.
- **Market engine** ([src/engine.ts](src/engine.ts)) — opens seven standard
  markets per World Cup fixture automatically, tracks live implied
  probabilities from the odds stream, and settles every market the moment the
  scores feed reports the match finalised.
- **Dashboard** ([public/](public/)) — a real-time trading-terminal interface:
  live scoreline and event feed, staged staking and settlement flows, and a
  full proof receipt (statistics, predicate, raw Merkle payload, transaction)
  for every settled market.

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

TxLINE stat keys: 1/2 goals, 3/4 yellow cards, 7/8 corners; +1000 denotes the
first-half variant. The NO side settles by proving the integer negation —
e.g. NO on "sum > 2" proves "sum < 3" on-chain.

## TxLINE endpoints used

| Purpose | Endpoint |
|---|---|
| Guest session | `POST {origin}/auth/guest/start` |
| Subscription (on-chain) | `txoracle.subscribe(level, weeks)` — free tier, devnet |
| Token activation | `POST {api}/token/activate` |
| Fixtures | `GET {api}/fixtures/snapshot` |
| Odds (live) | `SSE {api}/odds/stream` — implied probabilities from `Pct` |
| Scores (live) | `SSE {api}/scores/stream` — lifecycle and settlement trigger |
| Score history | `GET {api}/scores/{historical,updates,snapshot}/{fixtureId}` — finalised-record lookup with endpoint fallback |
| **Merkle proofs** | `GET {api}/scores/stat-validation?fixtureId&seq&statKey&statKey2` |
| On-chain validation | `txoracle.validate_stat` — via CPI from the escrow program |

Authentication on every data call: `Authorization: Bearer <guest JWT>` together
with `X-Api-Token: <activated token>`.

## Running the system

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

On first run, a burner keypair is generated and registered with TxLINE's free
tier on-chain, and the activated API token is cached under `data/`. The system
uses devnet SOL exclusively; no real funds are involved at any point.

The program was built and deployed with [Solana Playground](https://beta.solpg.io);
the exact source is committed at [program/src/lib.rs](program/src/lib.rs) and
the generated IDL at [idl/proofpitch.json](idl/proofpitch.json).

## Determinism and safety

- Settlement logic is a pure function of the proof payload: the same proof
  yields the same outcome, off-chain and on-chain alike.
- The program never acts on a FALSE oracle answer — indistinguishable from an
  invalid proof — and records outcomes only on TRUE.
- Stats must carry `period == 100` (the finalised record); an in-play proof
  cannot settle a market early.
- The daily-roots account is re-derived inside the program from the proof's
  own batch timestamp; a forged roots account is rejected.
- Claims use u128 pro-rata arithmetic with floor rounding; payouts can never
  exceed the pot.
- The score-history lookup falls back across all three scores endpoints
  (`/historical` → `/updates` → `/snapshot`): during the live run, the
  finalised record of the third-place final was absent from `/historical`
  yet present in the other two — the fallback is what allowed autonomous
  settlement to proceed.
- `npm test` runs the offline suite: predicate evaluation and negation, PDA
  derivations, instruction encoding, and the live-feed encodings observed on
  devnet (PascalCase fields, `StatusId` phases, SSE-shaped history endpoints,
  sparse score cells).

## Project status

- [x] TxLINE authentication and live feeds (fixtures, odds, scores)
- [x] `validate_stat` proven end-to-end from TypeScript (`npm run probe`)
- [x] Escrow program: create / join / settle-via-CPI / claim / void
- [x] Autonomous market engine and keeper settlement
- [x] Real-time dashboard, Phantom staking, proof receipts
- [x] Full lifecycle rehearsed on devnet — France v Spain (0–2, 14 July):
      create → stake both sides → settle NO via on-chain proof → claim
- [x] Unattended live run — third-place final (France 4–6 England, 18 July):
      all seven markets settled autonomously with real TxLINE Merkle proofs
      at full time; winning positions claimed; receipts in the dashboard
- [x] Public deployment (24/7 live instance)
- [x] Demo video
- [ ] Submission on Superteam Earn (deadline 19 July, 23:59 UTC)

## Author

Built solo by [@nulldegen](https://github.com/nulldegen) — independent
developer focused on autonomous agents and verifiable on-chain systems.

**Stack:** TypeScript · Node.js · Rust (Anchor) · @solana/web3.js · SSE · Express + WebSocket

Contact: kickfusion86@gmail.com

## License

All rights reserved. The source is public so that judges — and anyone else —
can audit the settlement logic and verify the on-chain record; it is not
licensed for reuse or resubmission.
