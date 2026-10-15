import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { cfg, type Target } from "../config.js";
import { log } from "../log.js";

const SOL = "So11111111111111111111111111111111111111112";

interface JupQuote {
  outAmount: string;
  routePlan: { swapInfo: { label: string } }[];
  priceImpactPct: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Buy a token through Jupiter instead of the bonding curve.
 * Used when the curve is already complete at detection (the launch buy filled it), which means the
 * coin has migrated to an AMM pool. Jupiter needs a few seconds to index a brand-new pool, so the
 * quote is retried until `jupiterTimeoutMs`.
 */
export async function buyViaJupiter(
  conn: Connection,
  wallet: Keypair,
  mint: PublicKey,
  target: Target,
  owner?: PublicKey,
): Promise<{ sig: string | null; simulated: boolean }> {
  const t0 = performance.now();
  const lamports = Math.floor(target.buyAmount * 1e9);
  const slippageBps = target.slippageBps ?? 1500;
  const timeout = target.jupiterTimeoutMs ?? 120_000;
  const user = owner ?? wallet.publicKey;

  let quote: JupQuote | null = null;
  let lastErr = "";
  let attempts = 0;
  while (performance.now() - t0 < timeout) {
    attempts++;
    try {
      const url =
        `${cfg.solana.jupiterUrl}/swap/v1/quote?inputMint=${SOL}&outputMint=${mint.toBase58()}` +
        `&amount=${lamports}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
      const r = await fetch(url);
      const j = (await r.json()) as JupQuote & { error?: string };
      if (j.error || !j.outAmount) lastErr = j.error ?? "no route";
      else {
        quote = j;
        break;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    if (attempts === 1) log.info(`solana: ${target.label} waiting for Jupiter to index the migrated pool (${lastErr})…`);
    await sleep(500);
  }
  if (!quote) throw new Error(`Jupiter found no route after ${(timeout / 1000).toFixed(0)}s: ${lastErr}`);

  const impactPct = Number(quote.priceImpactPct) * 100;
  const maxImpact = target.maxPriceImpactPct ?? 10;
  if (impactPct > maxImpact)
    throw new Error(
      `Jupiter route price impact ${impactPct.toFixed(2)}% exceeds maxPriceImpactPct ${maxImpact}% ` +
        `(pool too thin for ${target.buyAmount} SOL) — not buying`,
    );

  const swapRes = await fetch(`${cfg.solana.jupiterUrl}/swap/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: Math.max(cfg.solana.jitoTipLamports, 1_000_000),
          priorityLevel: "veryHigh",
        },
      },
    }),
  }).then((r) => r.json() as Promise<{ swapTransaction?: string; error?: string; simulationError?: unknown }>);
  if (!swapRes.swapTransaction) throw new Error(`Jupiter swap build failed: ${JSON.stringify(swapRes.error ?? swapRes.simulationError)}`);

  const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, "base64"));
  const route = quote.routePlan.map((p) => p.swapInfo.label).join(" + ");
  log.info(
    `solana: ${target.label} Jupiter route ${route}, ~${(Number(quote.outAmount) / 1e6).toLocaleString()} tokens ` +
      `(price impact ${impactPct.toFixed(2)}%), ready in ${(performance.now() - t0).toFixed(0)}ms`,
  );

  if (!cfg.live) {
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    log.info(`solana: PAPER MODE, not sent. Jupiter simulation ${sim.value.err ? "FAILED " + JSON.stringify(sim.value.err) : "OK"}`);
    return { sig: null, simulated: !sim.value.err };
  }

  tx.sign([wallet]);
  const raw = tx.serialize();
  const sig = bs58.encode(tx.signatures[0]);
  await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  log.hit(`solana: SENT via Jupiter ${sig} (${(performance.now() - t0).toFixed(0)}ms after detection)`);
  return { sig, simulated: true };
}
