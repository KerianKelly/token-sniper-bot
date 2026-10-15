import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createDbcProgram, deriveDbcPoolAuthority, deriveDbcEventAuthority, swapQuote, swapQuotePartialFill } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import bs58 from "bs58";
import { cfg, type Target } from "../config.js";
import { log } from "../log.js";
import { DBC_PROGRAM_ID, type DbcLaunch } from "./parse.js";
import { buyViaJupiter } from "./jupiter.js";

const FALLBACK_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
];

export class SolanaSniper {
  readonly conn: Connection;
  readonly wallet: Keypair;
  private program;
  private blockhash?: { blockhash: string; lastValidBlockHeight: number };
  private tipAccounts: PublicKey[] = FALLBACK_TIP_ACCOUNTS.map((a) => new PublicKey(a));
  private timer?: NodeJS.Timeout;

  constructor(wallet?: Keypair) {
    this.conn = new Connection(cfg.solana.rpcUrl(), {
      commitment: "processed",
      wsEndpoint: cfg.solana.wsUrl(),
    });
    this.wallet = wallet ?? Keypair.fromSecretKey(bs58.decode(cfg.solana.privateKey()));
    this.program = createDbcProgram(this.conn, "processed").program;
  }

  /** Keep a fresh blockhash + Jito tip accounts cached so the buy path makes no extra round trips. */
  async warm() {
    const refresh = async () => {
      this.blockhash = await this.conn.getLatestBlockhash("confirmed").catch(() => this.blockhash);
    };
    await refresh();
    this.timer = setInterval(refresh, 2_000);
    try {
      const r = await fetch(`${cfg.solana.jitoUrl}/api/v1/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
      }).then((r) => r.json());
      if (Array.isArray(r.result) && r.result.length) this.tipAccounts = r.result.map((a: string) => new PublicKey(a));
    } catch {
      /* keep fallback list */
    }
    const bal = await this.conn.getBalance(this.wallet.publicKey);
    log.info(`solana: wallet ${this.wallet.publicKey.toBase58()} balance ${(bal / 1e9).toFixed(4)} SOL`);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Load pool + config at processed commitment. The RPC can lag the gRPC feed by a few ms, so retry briefly. */
  private async loadPool(launch: DbcLaunch) {
    for (let i = 0; i < 40; i++) {
      const [p, c] = await this.conn.getMultipleAccountsInfo([launch.pool, launch.config], "processed");
      if (p && c) {
        return {
          virtualPool: this.program.coder.accounts.decode("virtualPool", p.data),
          config: this.program.coder.accounts.decode("poolConfig", c.data),
        };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`pool ${launch.pool.toBase58()} not visible on RPC after 2s`);
  }

  async buy(launch: DbcLaunch, target: Target) {
    const t0 = performance.now();
    const { virtualPool, config } = await this.loadPool(launch);
    const quoteIsSol = launch.quoteMint.equals(NATIVE_MINT);
    const quoteProgram = config.quoteTokenFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
    const baseProgram = launch.token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    // The creator's own buy can fill the whole curve in the launch tx; the coin is then already on an AMM.
    if (virtualPool.poolState.quoteReserve.gte(config.migrationQuoteThreshold)) {
      if (target.jupiterFallback === false) throw new Error("curve already completed at launch and jupiterFallback is off");
      if (!quoteIsSol) throw new Error("curve already completed at launch; Jupiter fallback only supports SOL-paired coins");
      log.warn(`solana: ${target.label} curve was completed by the launch tx; routing through Jupiter`);
      const simOwnerEarly = !cfg.live && process.env.SIM_OWNER ? new PublicKey(process.env.SIM_OWNER) : undefined;
      return buyViaJupiter(this.conn, this.wallet, launch.baseMint, target, simOwnerEarly);
    }

    const quoteDecimals = quoteIsSol ? 9 : await this.mintDecimals(launch.quoteMint);
    const amountIn = new BN(Math.floor(target.buyAmount * 10 ** quoteDecimals).toString());

    // SIM_OWNER (replay only): simulate as a funded public wallet; tx is left unsigned and never sent.
    const simOwner = !cfg.live && process.env.SIM_OWNER ? new PublicKey(process.env.SIM_OWNER) : null;
    const owner = simOwner ?? this.wallet.publicKey;
    const quoteAta = getAssociatedTokenAddressSync(launch.quoteMint, owner, false, quoteProgram);
    const baseAta = getAssociatedTokenAddressSync(launch.baseMint, owner, false, baseProgram);

    if (!quoteIsSol) {
      const bal = await this.conn.getTokenAccountBalance(quoteAta).catch(() => null);
      if (!bal || new BN(bal.value.amount).lt(amountIn)) {
        throw new Error(
          `pool is paired with ${launch.quoteMint.toBase58()}, wallet holds ${bal?.value.uiAmountString ?? 0}; need ${target.buyAmount}. Pre-buy the quote token.`,
        );
      }
    }

    const currentPoint = config.activationType === 0 ? new BN(launch.slot) : new BN(Math.floor(Date.now() / 1000));
    const slippageBps = target.slippageBps ?? 1500;
    let partialFill = false;
    let quote;
    try {
      quote = swapQuote(virtualPool, config, false, amountIn, slippageBps, false, currentPoint, false);
    } catch (e) {
      // The curve can't absorb the whole buy (it would pass the migration threshold). Switch to the
      // program's partial-fill mode: it takes what fits and leaves the rest, instead of reverting.
      quote = swapQuotePartialFill(virtualPool, config, false, amountIn, slippageBps, false, currentPoint, false);
      const fits = amountIn.sub(quote.amountLeft);
      if (fits.lten(0)) throw e;
      partialFill = true;
      log.warn(
        `solana: ${target.label} curve only absorbs ${(Number(fits.toString()) / 10 ** quoteDecimals).toFixed(4)} of ${target.buyAmount} SOL; using partial fill (${(e as Error).message})`,
      );
    }

    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.solana.computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.solana.priorityFeeMicroLamports }),
      createAssociatedTokenAccountIdempotentInstruction(owner, quoteAta, owner, launch.quoteMint, quoteProgram),
      createAssociatedTokenAccountIdempotentInstruction(owner, baseAta, owner, launch.baseMint, baseProgram),
    ];
    if (quoteIsSol) {
      ixs.push(
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: quoteAta, lamports: BigInt(amountIn.toString()) }),
        createSyncNativeInstruction(quoteAta),
      );
    }

    const minimumAmountOut =
      quote.minimumAmountOut ?? quote.outputAmount.mul(new BN(10_000 - slippageBps)).div(new BN(10_000));

    const needsSysvarIx = config.poolFees.baseFee.baseFeeMode === 2 || config.enableFirstSwapWithMinFee;
    const swapMethod = partialFill
      ? this.program.methods.swap2({ amount0: amountIn, amount1: minimumAmountOut, swapMode: 1 }) // 1 = PartialFill
      : this.program.methods.swap({ amountIn, minimumAmountOut });
    const swapIx = await swapMethod
      .accountsPartial({
        poolAuthority: deriveDbcPoolAuthority(),
        config: launch.config,
        pool: launch.pool,
        inputTokenAccount: quoteAta,
        outputTokenAccount: baseAta,
        baseVault: launch.baseVault,
        quoteVault: launch.quoteVault,
        baseMint: launch.baseMint,
        quoteMint: launch.quoteMint,
        payer: owner,
        tokenBaseProgram: baseProgram,
        tokenQuoteProgram: quoteProgram,
        referralTokenAccount: null,
        eventAuthority: deriveDbcEventAuthority(),
        program: DBC_PROGRAM_ID,
      })
      .remainingAccounts(
        needsSysvarIx
          ? [{ pubkey: new PublicKey("Sysvar1nstructions1111111111111111111111111"), isSigner: false, isWritable: false }]
          : [],
      )
      .instruction();
    ixs.push(swapIx);
    if (quoteIsSol) ixs.push(createCloseAccountInstruction(quoteAta, owner, owner));
    const tip = this.tipAccounts[Math.floor(Math.random() * this.tipAccounts.length)];
    ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: tip, lamports: cfg.solana.jitoTipLamports }));

    if (!this.blockhash) this.blockhash = await this.conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: this.blockhash.blockhash, instructions: ixs }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    if (!simOwner) tx.sign([this.wallet]);
    const raw = tx.serialize();
    const sig = bs58.encode(tx.signatures[0]);
    const built = performance.now() - t0;

    const expectedOut = Number(quote.outputAmount.toString()) / 10 ** config.tokenDecimal;
    log.info(
      `solana: ${target.label} buy ${target.buyAmount}${partialFill ? " (partial fill)" : ""} → ~${expectedOut.toLocaleString()} tokens (min ${minimumAmountOut.toString()}), built in ${built.toFixed(0)}ms`,
    );

    if (!cfg.live) {
      const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      log.info(`solana: PAPER MODE, not sent. simulation ${sim.value.err ? "FAILED " + JSON.stringify(sim.value.err) : "OK"}`);
      if (sim.value.err) log.info(sim.value.logs?.slice(-6).join("\n"));
      return { sig: null, simulated: !sim.value.err };
    }

    // Fan out: Jito block engine + regular RPC. Same signature, so it lands at most once.
    const b64 = Buffer.from(raw).toString("base64");
    await Promise.allSettled([
      fetch(`${cfg.solana.jitoUrl}/api/v1/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [b64, { encoding: "base64" }] }),
      }),
      this.conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }),
    ]);
    log.hit(`solana: SENT ${sig} (${(performance.now() - t0).toFixed(0)}ms after detection)`);
    this.confirm(sig);
    return { sig, simulated: true };
  }

  private async confirm(sig: string) {
    for (let i = 0; i < 60; i++) {
      const s = (await this.conn.getSignatureStatuses([sig])).value[0];
      if (s?.err) return log.error(`solana: tx ${sig} failed`, JSON.stringify(s.err));
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized")
        return log.hit(`solana: CONFIRMED ${sig} in slot ${s.slot}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    log.warn(`solana: ${sig} not confirmed after 30s (likely dropped)`);
  }

  private decimals = new Map<string, number>();
  private async mintDecimals(mint: PublicKey) {
    const k = mint.toBase58();
    if (!this.decimals.has(k)) {
      const info = await this.conn.getParsedAccountInfo(mint);
      this.decimals.set(k, (info.value?.data as any).parsed.info.decimals);
    }
    return this.decimals.get(k)!;
  }
}
