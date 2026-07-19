// Dev utility: claim every winning (or void) position of the demo/keeper
// wallet on settled markets — recovers the escrowed demo stakes.
import { PublicKey } from '@solana/web3.js';
import { loadKeypair } from '../auth.js';
import { PitchChain } from '../chain.js';

const chain = new PitchChain(loadKeypair());
const me = chain.payer.publicKey;
console.log('claiming for', me.toBase58());

const markets = new Map((await chain.allMarkets()).map((m) => [m.address, m]));
const positions = await chain.positionsOf(me);
console.log('positions:', positions.length);

for (const p of positions) {
  if (p.claimed) { console.log('already claimed:', p.address.slice(0, 8)); continue; }
  const m = markets.get(p.market);
  if (!m) continue;
  // market.state: 0 open, 1 settled_yes, 2 settled_no, 3 void (see chain.ts)
  const winSide = m.state === 1 ? 1 : m.state === 2 ? 2 : null;
  const claimable = m.state === 3 || (winSide !== null && p.side === winSide);
  if (!claimable) { console.log(`skip (losing/open): market ${p.market.slice(0, 8)} side ${p.side} state ${m.state}`); continue; }
  try {
    const sig = await chain.claim(new PublicKey(p.market), p.side);
    console.log(`CLAIMED market ${p.market.slice(0, 8)} side ${p.side} -> ${sig.slice(0, 20)}...`);
  } catch (e: any) {
    console.log(`claim failed ${p.market.slice(0, 8)}: ${e.message?.slice(0, 100)}`);
  }
}
console.log('balance after:', (await chain.connection.getBalance(me)) / 1e9, 'SOL');
