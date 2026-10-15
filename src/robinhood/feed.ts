import { decodeFunctionResult, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, toHex, type PublicClient } from "viem";
import { log } from "../log.js";

/** Contracts a Perpshood launch tx is sent to. */
export const LAUNCH_ENTRYPOINTS = new Set([
  "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", // Pons v2 factory: launchToken
  "0xe33e9e479df8802cb0866d5d05258bec4cf62948", // launchAndBuy helper
]);
const launchReturnAbi = parseAbi(["function launch() returns (address token, address curve)"]);

/**
 * Simulate the launch against latest state to learn (token, curve). The RPC is 1-2s behind the feed,
 * so the deployer's balance is overridden and reverts from stale state are retried for a few seconds.
 * The getLogs watcher still runs as a fallback if this never succeeds.
 */
async function predictAddresses(pub: PublicClient, from: `0x${string}`, to: `0x${string}`, data: `0x${string}`, value: bigint) {
  for (let i = 0; i < 40; i++) {
    let ret: `0x${string}` | undefined;
    try {
      ret = (
        await pub.call({
          account: from, to, data, value, blockTag: "latest",
          stateOverride: [{ address: from, balance: value + 10n ** 20n }],
        })
      ).data;
    } catch (e) {
      if (i === 39) log.warn("robinhood: could not simulate launch from feed, falling back to logs:", (e as Error).message.split("\n")[0]);
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    try {
      const [token, curve] = decodeFunctionResult({ abi: launchReturnAbi, functionName: "launch", data: ret! });
      return { token, curve };
    } catch {
      log.warn("robinhood: target tx to the factory did not return (token, curve); leaving it to the logs watcher");
      return null;
    }
  }
  return null;
}

export interface FeedLaunch {
  sequenceNumber: number; // == L2 block number
  txHash: `0x${string}`;
  from: `0x${string}`;
  token: `0x${string}`;
  curve: `0x${string}`;
}

/** Splits a Nitro L2 message into signed tx payloads (kind 3 = batch, kind 4 = signed tx). */
function* signedTxs(b: Uint8Array): Generator<Uint8Array> {
  if (b[0] === 3) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 1;
    while (o + 8 <= b.length) {
      const n = Number(dv.getBigUint64(o));
      o += 8;
      yield* signedTxs(b.subarray(o, o + n));
      o += n;
    }
  } else if (b[0] === 4) {
    yield b.subarray(1);
  }
}

/**
 * Reads the chain's public sequencer feed, which publishes ordered txs before the RPC serves the block.
 * When a target deployer sends a launch tx, it is simulated against latest state to learn the
 * token and curve addresses that the launch will create.
 */
export function watchSequencerFeed(
  url: string,
  pub: PublicClient,
  isTarget: (addr: string) => boolean,
  onLaunch: (l: FeedLaunch) => void,
): () => void {
  let ws: WebSocket | undefined;
  let stopped = false;
  let failures = 0;
  let lastMsg = Date.now();

  // Silent feeds (half-open sockets) are replaced; the getLogs watcher covers the gap.
  const watchdog = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN && Date.now() - lastMsg > 10_000) {
      log.warn("robinhood: sequencer feed silent for 10s, reconnecting");
      ws.close();
    }
  }, 5_000);

  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      if (failures > 0) log.info(`robinhood: sequencer feed reconnected after ${failures} failed attempt(s)`);
      else log.info("robinhood: sequencer feed connected");
      failures = 0;
      lastMsg = Date.now();
    };
    ws.onclose = () => {
      if (stopped) return;
      failures++;
      const delay = Math.min(500 * 2 ** (failures - 1), 15_000);
      if (failures === 1 || failures % 10 === 0)
        log.warn(`robinhood: sequencer feed unavailable (attempt ${failures}), retrying in ${delay}ms; backup log watcher still active`);
      setTimeout(connect, delay);
    };
    ws.onerror = () => {};
    ws.onmessage = async (m) => {
      lastMsg = Date.now();
      let j: any;
      try {
        j = JSON.parse(String(m.data));
      } catch {
        return;
      }
      for (const msg of j.messages ?? []) {
        const inner = msg.message?.message;
        if (inner?.header?.kind !== 3 || !inner.l2Msg) continue;
        for (const raw of signedTxs(Buffer.from(inner.l2Msg, "base64"))) {
          let serialized: `0x${string}`, tx: ReturnType<typeof parseTransaction>, from: `0x${string}`;
          try {
            serialized = toHex(raw);
            tx = parseTransaction(serialized);
            if (!tx.to || !tx.data || !LAUNCH_ENTRYPOINTS.has(tx.to.toLowerCase())) continue;
            from = await recoverTransactionAddress({ serializedTransaction: serialized as any });
          } catch {
            continue; // non-standard tx types (e.g. Arbitrum system txs) are not launches
          }
          if (!isTarget(from)) continue;
          try {
            const txHash = keccak256(serialized);
            log.info(`robinhood: feed saw target launch tx ${txHash} (seq ${msg.sequenceNumber}), simulating for addresses…`);
            const predicted = await predictAddresses(pub, from, tx.to!, tx.data!, tx.value ?? 0n);
            if (predicted) onLaunch({ sequenceNumber: msg.sequenceNumber, txHash, from, ...predicted });
          } catch (e) {
            log.warn("robinhood: feed decode/simulate failed", (e as Error).message.split("\n")[0]);
          }
        }
      }
    };
  };
  connect();
  return () => {
    stopped = true;
    clearInterval(watchdog);
    ws?.close();
  };
}
