import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import bs58 from "bs58";
import { cfg } from "../config.js";
import { log } from "../log.js";
import type { RawTx } from "./parse.js";

type Handler = (tx: RawTx) => void;

/**
 * Streams every transaction that touches one of `addresses`.
 * Uses Yellowstone gRPC (processed commitment, full tx inline) when SOLANA_GRPC_URL is set;
 * otherwise falls back to websocket logsSubscribe + getTransaction, which is ~0.5-1s slower.
 */
export async function watchAddresses(conn: Connection, addresses: string[], onTx: Handler): Promise<() => void> {
  if (cfg.solana.grpcUrl) {
    try {
      return await watchGrpc(addresses, onTx);
    } catch (e) {
      log.error(`solana: gRPC endpoint unusable (${(e as Error).message.split("\n")[0]}). Falling back. Clear SOLANA_GRPC_URL unless it is a Geyser/Yellowstone endpoint.`);
    }
  } else {
    log.warn("SOLANA_GRPC_URL not set: using websocket + polling fallback (slower). Use a Geyser gRPC endpoint for the fastest detection.");
  }
  return watchFallback(conn, addresses, onTx);
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

async function watchGrpc(addresses: string[], onTx: Handler): Promise<() => void> {
  const mod = await import("@triton-one/yellowstone-grpc");
  // CJS package: under Node ESM the class is the default export itself.
  const Client = mod.default as unknown as new (...a: unknown[]) => import("@triton-one/yellowstone-grpc").default;
  const { CommitmentLevel } = mod;
  const client = new Client(cfg.solana.grpcUrl!, cfg.solana.grpcToken, undefined);
  await withTimeout(client.connect(), 5000, "gRPC connect");
  await withTimeout(client.getVersion(), 5000, "gRPC getVersion");
  const stream = await client.subscribe();
  stream.on("data", (u: any) => {
    const t = u.transaction;
    if (!t?.transaction?.transaction) return;
    const info = t.transaction;
    const msg = info.transaction.message;
    const meta = info.meta;
    const keys = [
      ...msg.accountKeys,
      ...(meta?.loadedWritableAddresses ?? []),
      ...(meta?.loadedReadonlyAddresses ?? []),
    ].map((k: Uint8Array) => new PublicKey(k));
    onTx({
      signature: bs58.encode(info.signature),
      slot: Number(t.slot),
      accountKeys: keys,
      instructions: msg.instructions.map((ix: any) => ({
        programIdIndex: ix.programIdIndex,
        accounts: Array.from(ix.accounts as Uint8Array),
        data: Buffer.from(ix.data),
      })),
      failed: !!meta?.err,
    });
  });
  stream.on("error", (e: unknown) => log.error("gRPC stream error", e));
  await new Promise<void>((resolve, reject) =>
    stream.write(
      {
        transactions: {
          deployers: { vote: false, failed: false, accountInclude: addresses, accountExclude: [], accountRequired: [] },
        },
        commitment: CommitmentLevel.PROCESSED,
        accounts: {}, slots: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [],
      },
      (err: unknown) => (err ? reject(err) : resolve()),
    ),
  );
  log.info(`solana: gRPC watching ${addresses.length} deployer(s)`);
  return () => stream.end();
}

/**
 * Two racing detectors, both deduped by signature:
 * - logsSubscribe on SOLANA_WATCH_WS_URL (public mainnet by default; some paid RPCs don't support it)
 * - getSignaturesForAddress polling on SOLANA_RPC_URL
 */
async function watchFallback(conn: Connection, addresses: string[], onTx: Handler): Promise<() => void> {
  const seen = new Set<string>();
  const handleSig = async (sig: string, slot: number) => {
    if (seen.has(sig)) return;
    seen.add(sig);
    const tx = await fetchTxWithRetry(conn, sig);
    if (tx) onTx(fromVersionedResponse(sig, slot, tx));
  };

  // Every websocket in SOLANA_WATCH_WS_URL (comma-separated) races; first notification wins.
  const wsUrls = cfg.solana.watchWsUrl.split(",").map((u) => u.trim()).filter(Boolean);
  const subs = wsUrls.flatMap((ws) => {
    const wsConn = new Connection(cfg.solana.rpcUrl(), { wsEndpoint: ws, commitment: "processed" });
    return addresses.map((a) => {
      const id = wsConn.onLogs(
        new PublicKey(a),
        (l, ctx) => {
          if (l.err) return;
          if (!l.logs.some((x) => x.includes("InitializeVirtualPool"))) return;
          handleSig(l.signature, ctx.slot);
        },
        "processed",
      );
      return () => wsConn.removeOnLogsListener(id);
    });
  });

  let stopped = false;
  if (cfg.solana.signaturePollMs > 0) {
    // Own connection with no auto-retry on 429, so a throttled poll never stalls or queues behind buys.
    const pollConn = new Connection(cfg.solana.rpcUrl(), { commitment: "confirmed", disableRetryOnRateLimit: true });
    let rateLimitWarned = false;
    addresses.forEach((a, i) => {
      const key = new PublicKey(a);
      (async () => {
        await new Promise((r) => setTimeout(r, (cfg.solana.signaturePollMs / addresses.length) * i)); // stagger
        // Ignore history: only signatures newer than the one seen at startup count.
        let until = (await pollConn.getSignaturesForAddress(key, { limit: 1 }).catch(() => []))[0]?.signature;
        while (!stopped) {
          try {
            const sigs = await pollConn.getSignaturesForAddress(key, { limit: 20, until });
            if (sigs.length) {
              until = sigs[0].signature;
              for (const s of sigs.reverse()) if (!s.err) handleSig(s.signature, s.slot);
            }
          } catch (e) {
            const msg = (e as Error).message;
            if (msg.includes("429")) {
              if (!rateLimitWarned) log.warn("solana: signature polling is rate-limited by your RPC; raise SOLANA_SIGNATURE_POLL_MS");
              rateLimitWarned = true;
            } else log.warn("solana: signature poll error", msg.split("\n")[0]);
          }
          await new Promise((r) => setTimeout(r, cfg.solana.signaturePollMs));
        }
      })();
    });
  }
  log.info(`solana: watching ${addresses.length} deployer(s) via ${wsUrls.length} websocket(s) + ${cfg.solana.signaturePollMs}ms signature polling`);
  return () => {
    stopped = true;
    subs.forEach((unsub) => unsub());
  };
}

export async function fetchTxWithRetry(conn: Connection, sig: string, tries = 40): Promise<VersionedTransactionResponse | null> {
  for (let i = 0; i < tries; i++) {
    const tx = await conn
      .getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      .catch(() => null);
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 150));
  }
  log.warn("could not fetch tx", sig);
  return null;
}

export function fromVersionedResponse(signature: string, slot: number, tx: VersionedTransactionResponse): RawTx {
  const msg = tx.transaction.message;
  const keys = [
    ...msg.staticAccountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  return {
    signature,
    slot: tx.slot ?? slot,
    accountKeys: keys,
    instructions: msg.compiledInstructions.map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accounts: ix.accountKeyIndexes,
      data: Buffer.from(ix.data),
    })),
    failed: !!tx.meta?.err,
  };
}
