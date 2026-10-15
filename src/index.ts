import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { cfg, loadTargets, type Target } from "./config.js";
import { log } from "./log.js";
import { parseDbcLaunch } from "./solana/parse.js";
import { fetchTxWithRetry, fromVersionedResponse, watchAddresses } from "./solana/feed.js";
import { SolanaSniper } from "./solana/sniper.js";
import { RobinhoodSniper, PONS_FACTORY, type PonsLaunch } from "./robinhood/sniper.js";
import { watchSequencerFeed } from "./robinhood/feed.js";
import { runPresale } from "./robinhood/presale.js";
import { parseEventLogs, parseAbi } from "viem";

async function run() {
  const targets = loadTargets();
  const sol = targets.filter((t) => t.chain === "solana");
  const rh = targets.filter((t) => t.chain === "robinhood" && t.type !== "presale");
  const presales = targets.filter((t) => t.type === "presale");
  log.info(
    `mode: ${cfg.live ? "🔴 LIVE (real funds)" : "PAPER (set LIVE=true to send)"}; ${sol.length} solana, ${rh.length} robinhood, ${presales.length} presale target(s)`,
  );
  for (const t of presales) await runPresale(t);
  const fired = new Set<Target>();

  if (sol.length) {
    const sniper = new SolanaSniper();
    await sniper.warm();
    // Leave room for fees, the Jito tip and token-account rent on top of the buy amount.
    const needed = sol.reduce((n, t) => n + t.buyAmount, 0);
    const overhead = (cfg.solana.jitoTipLamports + cfg.solana.priorityFeeMicroLamports * cfg.solana.computeUnits / 1e6) / 1e9 + 0.005;
    const balance = (await sniper.conn.getBalance(sniper.wallet.publicKey)) / 1e9;
    if (balance < needed + overhead)
      log.warn(
        `solana: balance ${balance.toFixed(4)} SOL is tight for ${needed} SOL of buys + ~${overhead.toFixed(4)} SOL fees/tip/rent. ` +
          `Lower buyAmount to ~${Math.max(0, balance - overhead).toFixed(3)} or add SOL.`,
      );
    const byDeployer = new Map(sol.map((t) => [t.deployer, t]));
    await watchAddresses(sniper.conn, [...byDeployer.keys()], (tx) => {
      const launch = parseDbcLaunch(tx);
      if (!launch) return;
      const target = byDeployer.get(launch.creator.toBase58()) ?? tx.accountKeys.map((k) => byDeployer.get(k.toBase58())).find(Boolean);
      if (!target || (target.once !== false && fired.has(target))) return;
      fired.add(target);
      log.hit(`solana: ${target.label} LAUNCH mint=${launch.baseMint.toBase58()} pool=${launch.pool.toBase58()} slot=${launch.slot} tx=${launch.signature}`);
      sniper.buy(launch, target).catch((e) => log.error(`solana: ${target.label} buy failed:`, e.message));
    });
  }

  if (rh.length) {
    const sniper = new RobinhoodSniper();
    await sniper.warm();
    const byDeployer = new Map(rh.map((t) => [t.deployer.toLowerCase(), t]));
    const isTarget = (a: string) => byDeployer.has(a.toLowerCase());
    const handledTx = new Set<string>();
    // Two detectors race: the sequencer feed (fast) and factory getLogs (fallback). First one wins per tx.
    const onLaunch = (launch: PonsLaunch) => {
      if (handledTx.has(launch.txHash.toLowerCase())) return;
      handledTx.add(launch.txHash.toLowerCase());
      const target = byDeployer.get(launch.deployer.toLowerCase()) ?? byDeployer.get((launch.txFrom ?? "").toLowerCase());
      if (!target || (target.once !== false && fired.has(target))) return;
      fired.add(target);
      log.hit(`robinhood: ${target.label} LAUNCH via ${launch.source} token=${launch.token} curve=${launch.curve} tx=${launch.txHash}`);
      sniper.buy(launch, target).catch((e) => log.error(`robinhood: ${target.label} buy failed:`, e.message));
    };
    watchSequencerFeed(cfg.robinhood.feedUrl, sniper.pub as any, isTarget, (f) =>
      onLaunch({ txHash: f.txHash, block: BigInt(f.sequenceNumber), token: f.token, curve: f.curve, deployer: f.from, source: "feed" }),
    );
    await sniper.watch(isTarget, onLaunch);
  }
  log.info("armed. Ctrl+C to stop.");
}

/**
 * Replay a past launch through the same parse → quote → build → simulate path, in paper mode,
 * using a throwaway wallet. Proves the pipeline end to end without waiting for a real launch.
 */
async function replay(chain: string, id: string, amount = 0.01) {
  cfg.live = false;
  const target: Target = { label: "replay", chain: chain as Target["chain"], deployer: "", buyAmount: amount, maxSnipeTaxBps: 10_000 };
  if (chain === "solana") {
    const sniper = new SolanaSniper(Keypair.generate());
    await sniper.warm();
    const vtx = await fetchTxWithRetry(sniper.conn, id, 3);
    if (!vtx) throw new Error("tx not found");
    const launch = parseDbcLaunch(fromVersionedResponse(id, vtx.slot, vtx));
    if (!launch) throw new Error("no DBC pool creation in that tx");
    log.hit(`detected creator=${launch.creator.toBase58()} mint=${launch.baseMint.toBase58()} pool=${launch.pool.toBase58()} quote=${launch.quoteMint.toBase58()}`);
    // A historical slot would make the fee schedule look like launch time; fine for a smoke test.
    await sniper.buy(launch, target).catch((e) => log.error("buy build failed:", e.message));
    sniper.stop();
  } else {
    const sniper = new RobinhoodSniper(privateKeyToAccount(generatePrivateKey()));
    const receipt = await sniper.pub.getTransactionReceipt({ hash: id as `0x${string}` });
    const tx = await sniper.pub.getTransaction({ hash: id as `0x${string}` });
    const abi = parseAbi(["event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)"]);
    const ev = parseEventLogs({ abi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === PONS_FACTORY.toLowerCase()) })[0];
    if (!ev) throw new Error("no TokenLaunched in that tx");
    log.hit(`detected deployer=${ev.args.deployer} from=${tx.from} token=${ev.args.token} curve=${ev.args.curve}`);
    await sniper
      .buy({ txHash: id as `0x${string}`, block: receipt.blockNumber, token: ev.args.token, curve: ev.args.curve, deployer: ev.args.deployer, pairToken: ev.args.pairToken, source: "logs" }, target)
      .catch((e) => log.error("buy build failed:", e.message));
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "replay") {
  replay(args[0], args[1], args[2] ? Number(args[2]) : undefined).then(() => process.exit(0)).catch((e) => (log.error(e.message), process.exit(1)));
} else {
  run().catch((e) => (log.error(e.message), process.exit(1)));
}
