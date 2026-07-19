/**
 * ProofPitch server — live TxLINE feeds in, market state + receipts out.
 *
 *   npm start            live devnet feeds + on-chain markets, port 4100
 *
 * The browser talks to:
 *   GET  /api/state                 full dashboard state (fixtures, markets, receipts)
 *   GET  /api/join-tx               unsigned join tx for Phantom (query: market, side, lamports, payer)
 *   GET  /api/claim-tx              unsigned claim tx for Phantom (query: market, side, payer)
 *   POST /api/demo/join             server demo-wallet stake (judge mode, no wallet needed)
 *   POST /api/settle                keeper: settle one market now (body: { market })
 *   GET  /api/receipt/:market       the full settlement receipt incl. Merkle proof payload
 *   WS   /                          state pushes on every change
 */
import http from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { PublicKey, Transaction } from '@solana/web3.js';
import { getSession, loadKeypair } from './auth.js';
import { FeedClient, parseScoreHistory, scoreSummary } from './feed.js';
import { Engine } from './engine.js';
import { PitchChain, ixJoin, ixClaim, PROGRAM_ID } from './chain.js';
import { NET, PORT } from './config.js';

async function main() {
  const session = await getSession();
  const feed = new FeedClient(session);
  const chain = new PitchChain(loadKeypair());
  const engine = new Engine(feed, chain);

  console.log(`[pp] wallet ${chain.payer.publicKey.toBase58()} — program ${PROGRAM_ID.toBase58()} on ${NET.name}`);

  await engine.loadFixtures().catch(e => console.error('[pp] fixtures:', e.message));
  await engine.refreshMarkets();
  void engine.ensureMarkets();

  // ── live streams ──────────────────────────────────────────────────────────
  feed.streamOdds({
    onOdds: raw => { engine.onOdds(raw); },
    onError: (e, retry) => console.error(`[odds] ${e.message.slice(0, 80)} retry=${retry}`),
    onOpen: () => console.log('[odds] stream connected'),
  });
  feed.streamScores({
    onScore: (raw, summary) => { engine.onScore(raw, summary); },
    onError: (e, retry) => console.error(`[scores] ${e.message.slice(0, 80)} retry=${retry}`),
    onOpen: () => console.log('[scores] stream connected'),
  });

  // ── settlement backfill: catch anything missed while offline ──────────────
  const backfill = async () => {
    for (const entry of engine.registry) {
      const acc = engine.markets.get(entry.address);
      if (acc && acc.state !== 0) continue;
      try {
        const history = await feed.finalisedHistory(entry.fixtureId);
        if (history.map(r => scoreSummary(r)).some(s => s.etFinal)) {
          await engine.settleFixture(entry.fixtureId);
        }
      } catch { /* fixture may have no history yet */ }
    }
  };
  void backfill();
  setInterval(() => void backfill(), 10 * 60 * 1000);
  setInterval(() => void engine.refreshMarkets(), 60 * 1000);
  setInterval(() => void engine.ensureMarkets(), 10 * 60 * 1000);

  // ── HTTP + WS ─────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use(express.static('./public'));

  app.get('/api/state', (_req, res) => {
    res.json({ ...engine.view(), network: NET.name, oracle: NET.oracleProgramId });
  });

  app.get('/api/receipt/:market', (req, res) => {
    const r = engine.receipts.get(req.params.market);
    if (!r) { res.status(404).json({ error: 'no receipt (market not settled by this keeper yet)' }); return; }
    res.json(r);
  });

  // Unsigned txs for the user's own wallet (Phantom signs & sends client-side).
  app.get('/api/join-tx', async (req, res) => {
    try {
      const market = new PublicKey(String(req.query.market));
      const side = Number(req.query.side);
      const lamports = BigInt(String(req.query.lamports));
      const payer = new PublicKey(String(req.query.payer));
      const tx = new Transaction().add(ixJoin(payer, market, side, lamports));
      tx.feePayer = payer;
      tx.recentBlockhash = (await chain.connection.getLatestBlockhash()).blockhash;
      res.json({ tx: tx.serialize({ requireAllSignatures: false }).toString('base64') });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.get('/api/claim-tx', async (req, res) => {
    try {
      const market = new PublicKey(String(req.query.market));
      const side = Number(req.query.side);
      const payer = new PublicKey(String(req.query.payer));
      const tx = new Transaction().add(ixClaim(payer, market, side));
      tx.feePayer = payer;
      tx.recentBlockhash = (await chain.connection.getLatestBlockhash()).blockhash;
      res.json({ tx: tx.serialize({ requireAllSignatures: false }).toString('base64') });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  /** Judge mode: the server's demo wallet takes the stake — no wallet needed. */
  app.post('/api/demo/join', async (req, res) => {
    try {
      const { market, side, lamports } = req.body ?? {};
      const sig = await chain.join(new PublicKey(String(market)), Number(side), BigInt(lamports ?? 10_000_000));
      await engine.refreshMarkets();
      res.json({ sig });
    } catch (e) { res.status(400).json({ error: (e as Error).message.slice(0, 200) }); }
  });

  app.post('/api/settle', async (req, res) => {
    try {
      const address = String(req.body?.market ?? '');
      const entry = engine.registry.find(r => r.address === address);
      if (!entry) { res.status(404).json({ error: 'unknown market' }); return; }
      const receipt = await engine.settleMarket(entry);
      await engine.refreshMarkets();
      res.json({ receipt: { ...receipt, validation: undefined } });
    } catch (e) { res.status(400).json({ error: (e as Error).message.slice(0, 300) }); }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const broadcast = () => {
    const msg = JSON.stringify({ type: 'state', data: { ...engine.view(), network: NET.name, oracle: NET.oracleProgramId } });
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  };
  engine.onChange = broadcast;
  setInterval(broadcast, 15_000);

  server.listen(PORT, () => console.log(`[pp] ProofPitch live on http://localhost:${PORT}`));
}

main().catch(e => { console.error('[pp] fatal:', e); process.exit(1); });
