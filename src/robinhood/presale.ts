import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, parseEventLogs } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { cfg, type Target } from "../config.js";
import { log } from "../log.js";
import { robinhoodChain } from "./sniper.js";

/**
 * daos.world tiered-whitelist presale (e.g. PaperDAO, 0x5b1f…412e). Wallets are whitelisted in
 * batches by addToWhitelist/setWhitelistTier; a whitelisted wallet calls deposit() with ETH, and
 * anything above its remaining allocation is refunded in the same tx.
 */
const presaleAbi = parseAbi([
  "function deposit() payable",
  "function depositable(address wallet) view returns (uint256)",
  "function walletInfo(address wallet) view returns (uint8 tier, uint256 allocation, uint256 deposited)",
  "function whitelistOpen() view returns (bool)",
  "function hardCap() view returns (uint256)",
  "function totalDeposited() view returns (uint256)",
  "event Deposited(address indexed wallet, uint8 indexed tier, uint256 amount, uint256 refunded, uint256 walletTotal)",
]);

/** deposit() measured at 93,754 gas on PaperDAO. */
const DEPOSIT_GAS = 150_000n;
const MAX_ATTEMPTS = 3;

interface WalletState {
  account: PrivateKeyAccount;
  wallet: ReturnType<typeof createWalletClient>;
  done: boolean;
  busy: boolean;
  attempts: number;
  lastTier: number;
}

export function presaleKeys(t: Target): `0x${string}`[] {
  const name = t.keysEnv ?? "ROBINHOOD_PRESALE_KEYS";
  const raw = process.env[name];
  if (!raw) throw new Error(`${t.label}: set ${name} to a comma-separated list of wallet private keys`);
  const keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
  for (const k of keys) if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${t.label}: ${name} has a malformed private key`);
  return keys as `0x${string}`[];
}

/**
 * Polls every wallet's eligibility and deposits the moment it is whitelisted. Paper mode simulates
 * the deposit once per wallet and stops; live mode sends it and confirms the Deposited event.
 */
export async function runPresale(t: Target) {
  const contract = t.contract!;
  const pub = createPublicClient({ chain: robinhoodChain, transport: http(cfg.robinhood.rpcUrl()) });
  const maxPerWallet = t.buyAmount ? parseEther(String(t.buyAmount)) : undefined;
  const wallets: WalletState[] = presaleKeys(t).map((k) => {
    const account = privateKeyToAccount(k);
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(cfg.robinhood.rpcUrl()) });
    return { account, wallet, done: false, busy: false, attempts: 0, lastTier: -1 };
  });

  const [hardCap, total] = await Promise.all([
    pub.readContract({ address: contract, abi: presaleAbi, functionName: "hardCap" }),
    pub.readContract({ address: contract, abi: presaleAbi, functionName: "totalDeposited" }),
  ]);
  log.info(`presale: ${t.label} ${contract} raised ${formatEther(total)}/${formatEther(hardCap)} ETH, watching ${wallets.length} wallet(s)`);

  const read = async () => {
    const calls = wallets.flatMap((w) => [
      { address: contract, abi: presaleAbi, functionName: "walletInfo", args: [w.account.address] } as const,
      { address: contract, abi: presaleAbi, functionName: "depositable", args: [w.account.address] } as const,
    ]);
    const [open, res] = await Promise.all([
      pub.readContract({ address: contract, abi: presaleAbi, functionName: "whitelistOpen" }),
      pub.multicall({ contracts: calls, allowFailure: false }),
    ]);
    return {
      open,
      info: wallets.map((_, i) => ({
        tier: (res[i * 2] as readonly [number, bigint, bigint])[0],
        allocation: (res[i * 2] as readonly [number, bigint, bigint])[1],
        deposited: (res[i * 2] as readonly [number, bigint, bigint])[2],
        depositable: res[i * 2 + 1] as bigint,
      })),
    };
  };

  // Startup report: where each wallet stands and whether it can afford its allocation.
  const first = await read();
  for (const [i, w] of wallets.entries()) {
    const s = first.info[i];
    const bal = await pub.getBalance({ address: w.account.address });
    w.lastTier = s.tier;
    log.info(
      `presale: ${w.account.address} tier ${s.tier || "none"} allocation ${formatEther(s.allocation)} deposited ${formatEther(s.deposited)} ` +
        `depositable ${formatEther(s.depositable)} balance ${formatEther(bal)} ETH`,
    );
  }
  if (!first.open) log.warn(`presale: ${t.label} whitelist round is closed right now; still polling`);

  const deposit = async (w: WalletState, value: bigint, tier: number) => {
    w.busy = true;
    w.attempts++;
    try {
      const [bal, block] = await Promise.all([pub.getBalance({ address: w.account.address }), pub.getBlock()]);
      const maxFeePerGas = ((block.baseFeePerGas ?? 10_000_000n) * BigInt(Math.round(cfg.robinhood.feeMultiplier * 100))) / 100n;
      if (bal < value + DEPOSIT_GAS * maxFeePerGas) {
        log.error(`presale: ${w.account.address} needs ${formatEther(value)} ETH + gas but holds ${formatEther(bal)}; skipping`);
        w.done = true;
        return;
      }
      const { request } = await pub.simulateContract({
        account: w.account, address: contract, abi: presaleAbi, functionName: "deposit", value, gas: DEPOSIT_GAS, maxFeePerGas, maxPriorityFeePerGas: 0n,
      });
      if (!cfg.live) {
        log.hit(`presale: ${w.account.address} tier ${tier} ELIGIBLE, deposit of ${formatEther(value)} ETH simulates OK (paper mode, not sent)`);
        w.done = true;
        return;
      }
      const hash = await w.wallet.writeContract(request);
      log.hit(`presale: ${w.account.address} tier ${tier} deposit ${formatEther(value)} ETH sent ${hash}`);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      const ev = parseEventLogs({ abi: presaleAbi, logs: receipt.logs, eventName: "Deposited" })[0];
      if (receipt.status !== "success" || !ev) throw new Error(`tx ${hash} ${receipt.status}, no Deposited event`);
      log.hit(
        `presale: ${w.account.address} DEPOSITED ${formatEther(ev.args.amount)} ETH (refunded ${formatEther(ev.args.refunded)}, ` +
          `wallet total ${formatEther(ev.args.walletTotal)}) block ${receipt.blockNumber}`,
      );
      w.done = true;
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message.split("\n")[0];
      if (w.attempts >= MAX_ATTEMPTS) {
        log.error(`presale: ${w.account.address} deposit failed ${w.attempts}x, giving up: ${msg}`);
        w.done = true;
      } else log.warn(`presale: ${w.account.address} deposit attempt ${w.attempts} failed, retrying: ${msg}`);
    } finally {
      w.busy = false;
    }
  };

  let failures = 0;
  const tick = async () => {
    let state;
    try {
      state = await read();
      failures = 0;
    } catch (e) {
      if (++failures % 20 === 1) log.warn(`presale: ${t.label} eligibility read failed (${failures}x):`, (e as Error).message.split("\n")[0]);
      return;
    }
    for (const [i, w] of wallets.entries()) {
      const s = state.info[i];
      if (s.tier !== w.lastTier) {
        log.info(`presale: ${w.account.address} tier ${w.lastTier || "none"} -> ${s.tier || "none"} (allocation ${formatEther(s.allocation)} ETH)`);
        w.lastTier = s.tier;
      }
      // Whitelist round only: an untiered wallet with depositable > 0 would be the public round.
      if (w.done || w.busy || !state.open || s.tier === 0 || s.depositable === 0n) continue;
      let value = s.depositable;
      if (maxPerWallet !== undefined) {
        const room = maxPerWallet > s.deposited ? maxPerWallet - s.deposited : 0n;
        if (room === 0n) {
          w.done = true;
          continue;
        }
        if (room < value) value = room;
      }
      void deposit(w, value, s.tier);
    }
    if (wallets.every((w) => w.done)) {
      log.info(`presale: ${t.label} all wallets handled, stopping`);
      clearInterval(timer);
    }
  };
  const timer = setInterval(tick, t.pollMs ?? 250);
  await tick();
}
