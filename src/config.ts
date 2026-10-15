import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";

export type Chain = "solana" | "robinhood";

export interface Target {
  label: string;
  chain: Chain;
  /** "launch" (default) snipes a deployer's new coin; "presale" deposits into a daos.world whitelist raise. */
  type?: "launch" | "presale";
  /** Wallet that will deploy the coin (Perpspad creator wallet / Perpshood deployer). Launch targets only. */
  deployer: string;
  /**
   * Amount of the quote token to spend, in whole units (e.g. 0.5 = 0.5 SOL or 0.5 ETH).
   * Presale: optional max per wallet; omitted means each wallet fills its whole tier allocation.
   */
  buyAmount: number;
  /** Presale: the raise contract. */
  contract?: `0x${string}`;
  /** Presale: env var holding the comma-separated wallet keys (default ROBINHOOD_PRESALE_KEYS). */
  keysEnv?: string;
  /** Presale: how often to re-check wallet eligibility (ms, default 250). */
  pollMs?: number;
  /** Max slippage vs. the quote computed at detection time. */
  slippageBps?: number;
  /** Robinhood only: don't buy while the Pons anti-snipe tax is above this (bps). */
  maxSnipeTaxBps?: number;
  /**
   * Robinhood only: send the buy the instant the launch tx appears on the sequencer feed, with no
   * tax or price check. Only for launches that list your wallet in snipeTaxExemptions.
   */
  instant?: boolean;
  /** Robinhood instant mode: minimum tokens to receive (whole tokens). Default 0 = no protection. */
  minTokensOut?: number;
  /**
   * Solana: if the bonding curve is already complete when the launch is detected (the creator's own
   * buy filled it), buy the migrated pool through Jupiter instead. Default true.
   */
  jupiterFallback?: boolean;
  /** How long to wait for Jupiter to index the new pool before giving up (ms). Default 120000. */
  jupiterTimeoutMs?: number;
  /**
   * Abort a Jupiter buy whose quoted price impact exceeds this percentage (default 10).
   * Slippage does not protect you here: a thin migrated pool prices the bad fill into the quote itself.
   */
  maxPriceImpactPct?: number;
  /** Buy only the first launch from this deployer, then stop watching it. Default true. */
  once?: boolean;
  enabled?: boolean;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}
const optEnv = (name: string) => (process.env[name] ? process.env[name] : undefined);
const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);

export const cfg = {
  /** Paper mode: detect + build + simulate, never broadcast. On unless LIVE=true. */
  live: process.env.LIVE === "true",
  targetsFile: process.env.TARGETS_FILE ?? "targets.json",

  solana: {
    rpcUrl: () => env("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
    wsUrl: () => optEnv("SOLANA_WS_URL"),
    /** Websocket(s) for logsSubscribe launch detection, comma-separated; they race. (Alchemy's Solana ws lacks logsSubscribe.) */
    watchWsUrl: process.env.SOLANA_WATCH_WS_URL ?? "wss://api.mainnet-beta.solana.com",
    /** Backup: poll getSignaturesForAddress on SOLANA_RPC_URL per deployer (0 disables). 2s stays under Alchemy free-tier limits. */
    signaturePollMs: num("SOLANA_SIGNATURE_POLL_MS", 2000),
    grpcUrl: optEnv("SOLANA_GRPC_URL"),
    grpcToken: optEnv("SOLANA_GRPC_TOKEN"),
    privateKey: () => env("SOLANA_PRIVATE_KEY"),
    priorityFeeMicroLamports: num("SOLANA_PRIORITY_FEE_MICROLAMPORTS", 2_000_000),
    computeUnits: num("SOLANA_COMPUTE_UNITS", 250_000),
    jitoTipLamports: num("JITO_TIP_LAMPORTS", 1_000_000),
    jitoUrl: process.env.JITO_URL ?? "https://mainnet.block-engine.jito.wtf",
    jupiterUrl: process.env.JUPITER_URL ?? "https://lite-api.jup.ag",
  },

  robinhood: {
    rpcUrl: () => env("ROBINHOOD_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
    /** RPC for the getLogs fallback watcher. Public by default: no block-range cap, spares your paid quota. */
    logsRpcUrl: process.env.ROBINHOOD_LOGS_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
    /** Backup log watcher cadence. The sequencer feed is the fast path, so this can be relaxed. */
    logsPollMs: num("ROBINHOOD_LOGS_POLL_MS", 1000),
    /** Max blocks per eth_getLogs request (Alchemy free tier: 10). */
    logsMaxRange: BigInt(num("ROBINHOOD_LOGS_MAX_RANGE", 2000)),
    /** Nitro sequencer feed: sees txs before the RPC serves them. */
    feedUrl: process.env.ROBINHOOD_FEED_URL ?? "wss://feed.mainnet.chain.robinhood.com",
    /** Optional websocket RPC for log subscriptions (the public RPC has none; polling is used then). */
    wsUrl: process.env.ROBINHOOD_WS_URL,
    privateKey: () => env("ROBINHOOD_PRIVATE_KEY") as `0x${string}`,
    gasLimit: BigInt(num("ROBINHOOD_GAS_LIMIT", 600_000)),
    /** Multiplier applied to the current base fee for maxFeePerGas. */
    feeMultiplier: num("ROBINHOOD_FEE_MULTIPLIER", 3),
    /** How often to re-read the anti-snipe tax while waiting for it to drop. */
    pollMs: num("ROBINHOOD_POLL_MS", 100),
  },
};

export function loadTargets(): Target[] {
  if (!existsSync(cfg.targetsFile)) throw new Error(`${cfg.targetsFile} not found (copy targets.example.json)`);
  const raw = JSON.parse(readFileSync(cfg.targetsFile, "utf8")) as Target[];
  const targets = raw.filter((t) => t.enabled !== false);
  for (const t of targets) {
    if (t.chain !== "solana" && t.chain !== "robinhood") throw new Error(`${t.label}: chain must be solana|robinhood`);
    if (t.type === "presale") {
      if (t.chain !== "robinhood") throw new Error(`${t.label}: presale targets are robinhood only`);
      if (!/^0x[0-9a-fA-F]{40}$/.test(t.contract ?? "")) throw new Error(`${t.label}: presale needs a contract address`);
      if (t.buyAmount !== undefined && !(t.buyAmount > 0)) throw new Error(`${t.label}: buyAmount must be > 0 or omitted`);
      continue;
    }
    if (!(t.buyAmount > 0)) throw new Error(`${t.label}: buyAmount must be > 0`);
    if (t.chain === "robinhood" && !/^0x[0-9a-fA-F]{40}$/.test(t.deployer)) throw new Error(`${t.label}: bad EVM address`);
    if (t.chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.deployer)) throw new Error(`${t.label}: bad Solana address`);
  }
  return targets;
}
