/** Network + API configuration. Devnet by default — zero real funds anywhere. */

export interface NetConfig {
  name: 'devnet' | 'mainnet';
  apiOrigin: string;
  apiBaseUrl: string;
  rpcUrl: string;
  /** TxLINE oracle program (publishes Merkle roots, exposes validate_stat). */
  oracleProgramId: string;
  txlMint: string;
}

export const DEVNET: NetConfig = {
  name: 'devnet',
  apiOrigin: 'https://txline-dev.txodds.com',
  apiBaseUrl: 'https://txline-dev.txodds.com/api',
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  oracleProgramId: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J',
  txlMint: '4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG',
};

export const MAINNET: NetConfig = {
  name: 'mainnet',
  apiOrigin: 'https://txline.txodds.com',
  apiBaseUrl: 'https://txline.txodds.com/api',
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  oracleProgramId: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA',
  txlMint: 'Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL',
};

export const NET: NetConfig = process.env.TXLINE_NET === 'mainnet' ? MAINNET : DEVNET;

// Service level 1 = World Cup & International Friendlies (free tier).
export const SERVICE_LEVEL_ID = Number(process.env.TXLINE_SERVICE_LEVEL ?? 1);
export const DURATION_WEEKS = 4;

/** ProofPitch escrow program (ours) — set after deployment. */
export const ESCROW_PROGRAM_ID = process.env.ESCROW_PROGRAM_ID || '';

export const KEYPAIR_PATH = process.env.BURNER_KEYPAIR_PATH || './agent.keypair.json';
export const TOKEN_CACHE_PATH = './data/txline_token.json';
export const PORT = Number(process.env.PORT ?? 4100);
