import { PublicKey } from "@solana/web3.js";

export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

// Anchor discriminators + account order from the DBC IDL (sdk v1.5.12).
const INIT_SPL = Buffer.from([140, 85, 215, 176, 102, 54, 104, 79]);
const INIT_2022 = Buffer.from([169, 118, 51, 78, 145, 110, 220, 155]);
// Both variants start with: config, pool_authority, creator, base_mint, quote_mint, pool, base_vault, quote_vault
const IDX = { config: 0, creator: 2, baseMint: 3, quoteMint: 4, pool: 5, baseVault: 6, quoteVault: 7 };

/** Transaction shape shared by the gRPC and websocket feeds. */
export interface RawTx {
  signature: string;
  slot: number;
  accountKeys: PublicKey[]; // static keys, then loaded writable, then loaded readonly
  instructions: { programIdIndex: number; accounts: number[]; data: Buffer }[];
  failed: boolean;
}

export interface DbcLaunch {
  signature: string;
  slot: number;
  creator: PublicKey;
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  token2022: boolean;
}

/** Returns the DBC pool creation in this tx, if any. */
export function parseDbcLaunch(tx: RawTx): DbcLaunch | null {
  if (tx.failed) return null;
  for (const ix of tx.instructions) {
    if (!tx.accountKeys[ix.programIdIndex]?.equals(DBC_PROGRAM_ID)) continue;
    const disc = ix.data.subarray(0, 8);
    const isSpl = disc.equals(INIT_SPL);
    if (!isSpl && !disc.equals(INIT_2022)) continue;
    const acc = (i: number) => tx.accountKeys[ix.accounts[i]];
    return {
      signature: tx.signature,
      slot: tx.slot,
      creator: acc(IDX.creator),
      config: acc(IDX.config),
      pool: acc(IDX.pool),
      baseMint: acc(IDX.baseMint),
      quoteMint: acc(IDX.quoteMint),
      baseVault: acc(IDX.baseVault),
      quoteVault: acc(IDX.quoteVault),
      token2022: !isSpl,
    };
  }
  return null;
}
