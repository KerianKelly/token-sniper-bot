import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  parseEventLogs,
  parseUnits,
  webSocket,
  type Hash,
  type Log,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { cfg, type Target } from "../config.js";
import { log } from "../log.js";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/** Pons v2 factory used by perpshood.fun (both launchToken and the launchAndBuy helper go through it). */
export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;

const factoryAbi = parseAbi([
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);
const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function isNativeQuote() view returns (bool)",
  "function pairToken() view returns (address)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function sellableTokens() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  "function graduated() view returns (bool)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

export interface PonsLaunch {
  txHash: Hash;
  block: bigint;
  token: `0x${string}`;
  curve: `0x${string}`;
  deployer: `0x${string}`;
  txFrom?: `0x${string}`;
  pairToken?: `0x${string}`;
  source: "feed" | "logs";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RobinhoodSniper {
  readonly account: PrivateKeyAccount;
  readonly pub;
  private wallet;
  private nonce = 0;
  private maxFeePerGas = 0n;
  private timer?: NodeJS.Timeout;

  constructor(account?: PrivateKeyAccount) {
    this.account = account ?? privateKeyToAccount(cfg.robinhood.privateKey());
    this.pub = createPublicClient({ chain: robinhoodChain, transport: http(cfg.robinhood.rpcUrl(), { batch: false }) });
    this.wallet = createWalletClient({ account: this.account, chain: robinhoodChain, transport: http(cfg.robinhood.rpcUrl()) });
  }

  /** Cache nonce and fee so the buy is a single eth_sendRawTransaction. */
  async warm() {
    const refresh = async () => {
      try {
        const [nonce, block] = await Promise.all([
          this.pub.getTransactionCount({ address: this.account.address, blockTag: "pending" }),
          this.pub.getBlock(),
        ]);
        this.nonce = nonce;
        const base = block.baseFeePerGas ?? 10_000_000n;
        this.maxFeePerGas = (base * BigInt(Math.round(cfg.robinhood.feeMultiplier * 100))) / 100n;
      } catch (e) {
        log.warn("robinhood: warm refresh failed", (e as Error).message.split("\n")[0]);
      }
    };
    await refresh();
    this.timer = setInterval(refresh, 1_000);
    const bal = await this.pub.getBalance({ address: this.account.address });
    log.info(`robinhood: wallet ${this.account.address} balance ${(Number(bal) / 1e18).toFixed(5)} ETH`);
  }

  stop() {
    clearInterval(this.timer);
  }

  /**
   * Streams TokenLaunched events from the Pons factory. Websocket push plus an HTTP getLogs poll
   * (whichever sees it first wins; duplicates are dropped).
   */
  async watch(isTarget: (addr: string) => boolean, onLaunch: (l: PonsLaunch) => void): Promise<() => void> {
    const seen = new Set<string>();
    const handle = async (raw: Log[]) => {
      const events = parseEventLogs({ abi: factoryAbi, logs: raw, eventName: "TokenLaunched" });
      for (const ev of events) {
        const key = `${ev.transactionHash}:${ev.logIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const launch: PonsLaunch = {
          txHash: ev.transactionHash!,
          block: ev.blockNumber!,
          token: ev.args.token,
          curve: ev.args.curve,
          deployer: ev.args.deployer,
          pairToken: ev.args.pairToken,
          source: "logs",
        };
        if (isTarget(launch.deployer)) {
          onLaunch(launch);
          continue;
        }
        // launchAndBuy goes through a helper contract; also match on the EOA that sent the tx.
        this.pub
          .getTransaction({ hash: launch.txHash })
          .then((tx) => {
            if (isTarget(tx.from)) onLaunch({ ...launch, txFrom: tx.from });
          })
          .catch(() => {});
      }
    };

    let stopped = false;
    let unwatchWs = () => {};
    if (cfg.robinhood.wsUrl) try {
      const wsClient = createPublicClient({ chain: robinhoodChain, transport: webSocket(cfg.robinhood.wsUrl!) });
      unwatchWs = wsClient.watchEvent({
        address: PONS_FACTORY,
        event: factoryAbi[0],
        onLogs: (logs) => handle(logs as Log[]),
        onError: (e) => log.warn("robinhood: ws error", e.message),
      });
    } catch (e) {
      log.warn("robinhood: websocket unavailable, polling only", (e as Error).message);
    }

    const logsClient = createPublicClient({ chain: robinhoodChain, transport: http(cfg.robinhood.logsRpcUrl, { retryCount: 0 }) });
    (async () => {
      let from = await logsClient.getBlockNumber();
      while (!stopped) {
        try {
          const tip = await logsClient.getBlockNumber();
          // Chunked so providers with a block-range cap (Alchemy free tier: 10) still work.
          while (tip >= from && !stopped) {
            const to = from + cfg.robinhood.logsMaxRange - 1n < tip ? from + cfg.robinhood.logsMaxRange - 1n : tip;
            const logs = await logsClient.getLogs({ address: PONS_FACTORY, event: factoryAbi[0], fromBlock: from, toBlock: to });
            await handle(logs as Log[]);
            from = to + 1n;
          }
        } catch (e) {
          const msg = (e as Error).message;
          log.warn("robinhood: backup log watcher error:", msg.includes("Too Many Requests") ? "rate-limited (429)" : msg.split("\n")[0]);
        }
        await sleep(cfg.robinhood.logsPollMs);
      }
    })();

    log.info("robinhood: watching Pons factory for target deployers");
    return () => {
      stopped = true;
      unwatchWs();
    };
  }

  private async curveState(curve: `0x${string}`) {
    const c = { address: curve, abi: curveAbi } as const;
    const r = await this.pub.multicall({
      allowFailure: false,
      contracts: [
        { ...c, functionName: "isNativeQuote" },
        { ...c, functionName: "pairToken" },
        { ...c, functionName: "getReserves" },
        { ...c, functionName: "sellableTokens" },
        { ...c, functionName: "feeBps" },
        { ...c, functionName: "creatorTaxBps" },
        { ...c, functionName: "currentSnipeTaxBps", args: [this.account.address] },
        { ...c, functionName: "graduated" },
      ],
    });
    const [isNative, pairToken, [quoteReserve, tokenReserve], sellable, feeBps, creatorTaxBps, snipeTaxBps, graduated] = r;
    return { isNative, pairToken, quoteReserve, tokenReserve, sellable, feeBps, creatorTaxBps, snipeTaxBps, graduated };
  }

  /** Mirrors the curve math used by the perpshood.fun frontend. */
  static quoteBuy(quoteIn: bigint, s: { quoteReserve: bigint; tokenReserve: bigint; sellable: bigint; feeBps: bigint; creatorTaxBps: bigint; snipeTaxBps: bigint }) {
    const taxes = s.feeBps + s.creatorTaxBps + s.snipeTaxBps;
    if (quoteIn <= 0n || taxes >= 10_000n) return 0n;
    const net = quoteIn - (quoteIn * taxes) / 10_000n;
    const out = (net * 10_000n * s.tokenReserve) / (s.quoteReserve * 10_000n + net * 10_000n);
    return out > s.sellable ? s.sellable : out;
  }

  private async signAndSend(tx: { to: `0x${string}`; data: `0x${string}`; value: bigint }) {
    const signed = await this.wallet.signTransaction({
      ...tx,
      account: this.account,
      chain: robinhoodChain,
      nonce: this.nonce++,
      gas: cfg.robinhood.gasLimit,
      maxFeePerGas: this.maxFeePerGas,
      maxPriorityFeePerGas: 0n,
      type: "eip1559",
    });
    return this.pub.sendRawTransaction({ serializedTransaction: signed });
  }

  private watchReceipt(hash: Hash) {
    this.pub
      .waitForTransactionReceipt({ hash, timeout: 30_000 })
      .then((r) => (r.status === "success" ? log.hit(`robinhood: CONFIRMED ${hash} block ${r.blockNumber}`) : log.error(`robinhood: REVERTED ${hash}`)))
      .catch((e) => log.warn("robinhood: receipt wait failed", e.message));
  }

  /**
   * instant mode: fire the buy the moment the launch is seen, without reading curve state.
   * Native-ETH curves only, and no price/tax check, so only use it when your wallet is in the
   * launch's snipeTaxExemptions (otherwise the first blocks take a 99% tax).
   */
  private async instantBuy(launch: PonsLaunch, target: Target) {
    const quoteIn = parseUnits(target.buyAmount.toString(), 18);
    const minOut = target.minTokensOut ? parseUnits(target.minTokensOut.toString(), 18) : 0n;
    const tx = {
      to: launch.curve,
      data: encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [quoteIn, minOut, this.account.address] }),
      value: quoteIn,
    };
    if (!cfg.live) {
      log.info(`robinhood: PAPER MODE instant buy of ${target.buyAmount} ETH on ${launch.curve} (not sent)`);
      return { hash: null, simulated: false };
    }
    const hash = await this.signAndSend(tx);
    log.hit(`robinhood: SENT instant ${hash}`);
    this.watchReceipt(hash);
    return { hash, simulated: false };
  }

  /** Curve state, retried while the RPC catches up to a launch first seen on the sequencer feed. */
  private async curveStateWhenLive(curve: `0x${string}`) {
    for (let i = 0; ; i++) {
      try {
        return await this.curveState(curve);
      } catch (e) {
        if (i > 200) throw e;
        await sleep(50);
      }
    }
  }

  async buy(launch: PonsLaunch, target: Target) {
    if (target.instant) return this.instantBuy(launch, target);
    const t0 = performance.now();
    const maxTax = BigInt(target.maxSnipeTaxBps ?? 100);

    // Wait out the anti-snipe tax (99% in the first blocks), re-reading every poll.
    let s = await this.curveStateWhenLive(launch.curve);
    let waitedLogged = false;
    while (s.snipeTaxBps > maxTax) {
      if (!waitedLogged) {
        log.info(`robinhood: ${target.label} snipe tax ${s.snipeTaxBps}bps > max ${maxTax}bps, waiting…`);
        waitedLogged = true;
      }
      if (performance.now() - t0 > 120_000) throw new Error("snipe tax did not drop within 2 min");
      await sleep(cfg.robinhood.pollMs / 2);
      s = await this.curveState(launch.curve);
    }
    if (s.graduated) throw new Error("curve already graduated");

    const decimals = s.isNative ? 18 : await this.pub.readContract({ address: s.pairToken, abi: erc20Abi, functionName: "decimals" });
    const quoteIn = parseUnits(target.buyAmount.toString(), decimals);
    const expected = RobinhoodSniper.quoteBuy(quoteIn, s);
    const minOut = (expected * BigInt(10_000 - (target.slippageBps ?? 1500))) / 10_000n;

    const txs: { to: `0x${string}`; data: `0x${string}`; value: bigint }[] = [];
    if (!s.isNative) {
      const bal = await this.pub.readContract({ address: s.pairToken, abi: erc20Abi, functionName: "balanceOf", args: [this.account.address] });
      if (bal < quoteIn) throw new Error(`curve is paired with ${s.pairToken}; wallet balance too low`);
      txs.push({ to: s.pairToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [launch.curve, quoteIn] }), value: 0n });
    }
    txs.push({
      to: launch.curve,
      data: encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [quoteIn, minOut, this.account.address] }),
      value: s.isNative ? quoteIn : 0n,
    });

    log.info(
      `robinhood: ${target.label} buy ${target.buyAmount} → ~${(Number(expected) / 1e18).toLocaleString()} tokens ` +
        `(tax fee=${s.feeBps} creator=${s.creatorTaxBps} snipe=${s.snipeTaxBps} bps), ready in ${(performance.now() - t0).toFixed(0)}ms`,
    );

    if (!cfg.live) {
      const last = txs[txs.length - 1];
      try {
        // SIM_FUND (replay only): give the throwaway wallet a balance inside the eth_call.
        const stateOverride = process.env.SIM_FUND ? [{ address: this.account.address, balance: 10n ** 21n }] : undefined;
        if (txs.length === 1)
          await this.pub.call({ account: this.account.address, to: last.to, data: last.data, value: last.value, stateOverride });
        log.info(`robinhood: PAPER MODE, not sent. simulation ${txs.length === 1 ? "OK" : "skipped (needs approve first)"}`);
        return { hash: null, simulated: true };
      } catch (e) {
        log.info(`robinhood: PAPER MODE, not sent. simulation FAILED: ${(e as Error).message.split("\n")[0]}`);
        return { hash: null, simulated: false };
      }
    }

    let hash: Hash | undefined;
    for (const tx of txs) hash = await this.signAndSend(tx);
    log.hit(`robinhood: SENT ${hash} (${(performance.now() - t0).toFixed(0)}ms after detection)`);
    this.watchReceipt(hash!);
    return { hash, simulated: true };
  }
}
