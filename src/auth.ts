/**
 * TxLINE authentication — full flow per the TxLINE docs:
 *   1. POST {apiOrigin}/auth/guest/start                      → guest JWT
 *   2. txoracle.subscribe(level, weeks) on-chain              → txSig
 *      (free tier: no TxL cost; the tx just registers the wallet)
 *   3. sign "txSig:leagues:jwt" with the burner wallet        → base64 signature
 *   4. POST {apiBaseUrl}/token/activate {txSig, walletSignature, leagues}
 *      with "Authorization: Bearer jwt"                       → persistent API token
 *
 * The activated token is cached in data/txline_token.json.
 */
import fs from 'node:fs';
import axios from 'axios';
import nacl from 'tweetnacl';
import * as anchor from '@coral-xyz/anchor';
import {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, getAccount,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { NET, SERVICE_LEVEL_ID, DURATION_WEEKS, KEYPAIR_PATH, TOKEN_CACHE_PATH } from './config.js';

const SELECTED_LEAGUES: string[] = []; // empty = everything in the tier

export function loadKeypair(): Keypair {
  // First run on a fresh clone: mint a new burner wallet (never committed —
  // *.keypair.json is git-ignored). It holds devnet SOL only, zero real funds.
  if (!fs.existsSync(KEYPAIR_PATH)) {
    const kp = Keypair.generate();
    fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(Array.from(kp.secretKey)));
    console.log(`[auth] no keypair found — generated new burner wallet ${kp.publicKey.toBase58()} at ${KEYPAIR_PATH}`);
    return kp;
  }
  const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export interface TxlineSession {
  jwt: string;
  apiToken: string;
  wallet: string;
  network: string;
}

/** Cached-token fast path; full flow otherwise. */
export async function getSession(): Promise<TxlineSession> {
  const kp = loadKeypair();

  try {
    const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8'));
    if (cached.network === NET.name && cached.wallet === kp.publicKey.toBase58() && cached.apiToken) {
      const jwt = await guestJwt();
      console.log('[auth] using cached API token');
      return { jwt, apiToken: cached.apiToken, wallet: cached.wallet, network: NET.name };
    }
  } catch { /* no cache */ }

  console.log(`[auth] full activation flow on ${NET.name} for ${kp.publicKey.toBase58()}`);
  const jwt = await guestJwt();
  const txSig = await subscribeOnChain(kp);
  console.log(`[auth] on-chain subscription tx: ${txSig}`);
  const apiToken = await activate(kp, jwt, txSig);

  fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify({
    network: NET.name, wallet: kp.publicKey.toBase58(), apiToken, txSig, activatedAt: new Date().toISOString(),
  }, null, 1));
  console.log('[auth] API token activated & cached ok');
  return { jwt, apiToken, wallet: kp.publicKey.toBase58(), network: NET.name };
}

async function guestJwt(): Promise<string> {
  const res = await axios.post(`${NET.apiOrigin}/auth/guest/start`);
  const jwt = res.data.token;
  if (!jwt) throw new Error(`guest/start: no token in response ${JSON.stringify(res.data)}`);
  return jwt;
}

/** Load the txoracle IDL: local file → docs origin → on-chain. */
export async function loadIdl(connection: Connection, wallet: anchor.Wallet): Promise<anchor.Idl> {
  const localPath = `./idl/txoracle.${NET.name}.json`;
  if (fs.existsSync(localPath)) return JSON.parse(fs.readFileSync(localPath, 'utf8').replace(/^﻿/, ''));

  for (const url of [`${NET.apiOrigin}/idl/txoracle.json`, `${NET.apiOrigin}/documentation/idl/txoracle.json`]) {
    try {
      const res = await axios.get(url, { timeout: 10_000 });
      if (res.data?.instructions) {
        fs.mkdirSync('./idl', { recursive: true });
        fs.writeFileSync(localPath, JSON.stringify(res.data));
        console.log(`[auth] IDL downloaded from ${url}`);
        return res.data;
      }
    } catch { /* try next */ }
  }

  const provider = new anchor.AnchorProvider(connection, wallet, {});
  const idl = await anchor.Program.fetchIdl(new PublicKey(NET.oracleProgramId), provider);
  if (!idl) throw new Error('txoracle IDL not found locally, via HTTP, or on-chain');
  fs.mkdirSync('./idl', { recursive: true });
  fs.writeFileSync(localPath, JSON.stringify(idl));
  console.log('[auth] IDL fetched on-chain and cached');
  return idl;
}

async function subscribeOnChain(kp: Keypair): Promise<string> {
  const connection = new Connection(NET.rpcUrl, 'confirmed');

  const balance = await connection.getBalance(kp.publicKey);
  console.log(`[auth] burner balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (NET.name === 'devnet' && balance < 0.05 * LAMPORTS_PER_SOL) {
    let funded = false;
    for (const sol of [1, 0.5, 0.1, 0.1, 0.1]) {
      try {
        console.log(`[auth] requesting devnet airdrop (${sol} SOL)…`);
        const sig = await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig, 'confirmed');
        console.log('[auth] airdrop landed');
        funded = true;
        break;
      } catch (e) {
        console.log(`[auth] airdrop refused (${(e as Error).message.slice(0, 60)}…), retrying in 3s`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!funded) {
      throw new Error(
        `Devnet faucet is rate-limiting. Get free devnet SOL manually:\n` +
        `  1. open https://faucet.solana.com\n` +
        `  2. paste address: ${kp.publicKey.toBase58()}\n` +
        `  3. select DEVNET, request 1 SOL, then re-run.`,
      );
    }
  }

  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const idl = await loadIdl(connection, wallet);
  const programId = new PublicKey(NET.oracleProgramId);
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const mint = new PublicKey(NET.txlMint);
  const [pricingMatrix] = PublicKey.findProgramAddressSync([Buffer.from('pricing_matrix')], programId);
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from('token_treasury_v2')], programId);

  // The TxL mint may live under the legacy Token program OR Token-2022 —
  // follow whichever program owns the mint, everywhere.
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error(`TxL mint ${NET.txlMint} not found on ${NET.name}`);
  const tokenProgram = mintInfo.owner;
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID)) console.log(`[auth] TxL mint uses token program ${tokenProgram.toBase58()}`);

  const tokenTreasuryVault = getAssociatedTokenAddressSync(mint, tokenTreasuryPda, true, tokenProgram);
  const userTokenAccount = getAssociatedTokenAddressSync(mint, kp.publicKey, false, tokenProgram);

  // subscribe() deserializes user_token_account even on the free tier (price 0),
  // so a brand-new wallet must create its empty TxL token account first.
  try {
    await getAccount(connection, userTokenAccount, 'confirmed', tokenProgram);
  } catch {
    console.log('[auth] creating TxL token account (one-time, rent only)…');
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(kp.publicKey, userTokenAccount, kp.publicKey, mint, tokenProgram),
    );
    await sendAndConfirmTransaction(connection, ataTx, [kp], { commitment: 'confirmed' });
    console.log('[auth] TxL token account created');
  }

  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: kp.publicKey,
      pricingMatrix,
      tokenMint: mint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
  return txSig;
}

async function activate(kp: Keypair, jwt: string, txSig: string): Promise<string> {
  const message = `${txSig}:${SELECTED_LEAGUES.join(',')}:${jwt}`;
  const signatureBytes = nacl.sign.detached(Buffer.from(message), kp.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString('base64');

  const res = await axios.post(
    `${NET.apiBaseUrl}/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } },
  );
  // /token/activate returns the API token as a plain-text string body.
  const apiToken = typeof res.data === 'string' ? res.data.trim() : res.data?.token;
  if (!apiToken) throw new Error(`token/activate: no token in response ${JSON.stringify(res.data)}`);
  return apiToken;
}
