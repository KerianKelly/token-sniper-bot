# Token Sniper Bot

Watches deployer wallets you already know and buys the coin they launch, the moment they launch it.

| Chain | Launchpad | What's detected | How |
|---|---|---|---|
| Solana | perpspad.fun | Meteora DBC `initialize_virtual_pool*` whose `creator` (or any account) is a target wallet | Yellowstone gRPC at `processed`; else racing `logsSubscribe` websockets + signature polling |
| Robinhood Chain | perpshood.fun | Pons v2 `launchToken` / `launchAndBuy` sent by a target wallet | Sequencer feed (pre-RPC) + factory `TokenLaunched` logs as fallback |

It starts in **paper mode**: it detects the launch, builds the real buy transaction and simulates it, but never sends. Set `LIVE=true` to trade.

## Setup

```bash
npm install
cp .env.example .env              # add fresh hot-wallet keys + RPCs
cp targets.example.json targets.json   # add the deployer addresses
npm start
```

`targets.json` entries:

| field | meaning |
|---|---|
| `chain` | `solana` or `robinhood` |
| `deployer` | wallet that will launch the coin |
| `buyAmount` | quote tokens to spend (SOL / ETH, or the pool's pair token) |
| `slippageBps` | min-out tolerance vs. the quote at detection (default 1500 = 15%) |
| `maxSnipeTaxBps` | Robinhood: wait until Pons anti-snipe tax ≤ this (default 100 = 1%) |
| `instant` | Robinhood: fire immediately on the feed with no tax/price check (see below) |
| `jupiterFallback` | Solana: if the curve is already complete at launch, buy the migrated pool via Jupiter (default true) |
| `jupiterTimeoutMs` | how long to wait for Jupiter to index the new pool (default 120000) |
| `maxPriceImpactPct` | refuse a Jupiter buy above this quoted price impact (default 10) |
| `once` | only buy the first launch from this deployer (default true) |
| `enabled` | set false to keep an entry without watching it |

## Testing against real past launches

```bash
# Perpspad launch tx → parse, quote, build, simulate (throwaway wallet; SIM_OWNER funds the simulation)
SIM_OWNER=5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9 npm run replay -- solana <launch signature> 0.01

# Perpshood launch tx
SIM_FUND=1 npm run replay -- robinhood <launch tx hash> 0.001
```

## Things that decide whether a snipe works

**Perpshood / Pons anti-snipe tax.** Each curve charges `currentSnipeTaxBps(buyer)`. Measured on one launch:
99% for the first 1–2 blocks, ~6% around blocks 5–10, 0 by ~30 blocks (~3 s; blocks are ~0.1 s).
Buying "in the launch block" gives almost all of your ETH away. The default flow reads the tax every
~50 ms and buys the first moment it is ≤ `maxSnipeTaxBps`.
The deployer can pass `snipeTaxExemptions` at launch. If your wallet is exempt, `instant: true` sends the
buy as soon as the launch tx appears on the sequencer feed (no state reads, `minTokensOut` default 0).

**Perpspad dev buy.** The creator's first buy is inside the pool-creation tx, so the best possible
position is right after it. The DBC pools seen so far also start with a ~4% fee that decays over ~5 min.

**Curve too small / already finished.** If the buy is larger than the curve can absorb, the bot switches
to the DBC partial-fill instruction: it takes what fits and the rest stays in the wallet, instead of the
whole tx reverting. If the creator's own buy *completed* the curve in the launch tx, the coin is already
on an AMM, and the bot buys it through Jupiter instead — but only if the quoted price impact is within
`maxPriceImpactPct`. Slippage alone will not save you there: a thin migrated pool prices the bad fill
into the quote itself (one replayed launch quoted 99.9% impact for 2.35 SOL, and 41% for 0.001 SOL).

**Pair token.** Both launchpads allow non-native pairs (USDC, custom tokens, USDG…). The bot buys with
whatever the pool is paired with, so the wallet must already hold enough of it; otherwise the buy is
skipped with an error.

**Infra.** On Solana the websocket fallback adds ~0.5–1 s. Use a gRPC (Geyser) endpoint and a paid RPC.
On Robinhood Chain the sequencer feed is public and is typically 1–5 s ahead of the public RPC; a
low-latency RPC (e.g. Alchemy) mainly speeds up sending and the tax/state reads.

## Presale target (daos.world whitelist raises, Robinhood Chain)

A target with `"type": "presale"` deposits into a daos.world tiered-whitelist raise (e.g. PaperDAO,
`0x5b1f1bea19f3bb69ac5f881a4419095b7484412e`). Put the whitelisted wallets' keys in
`ROBINHOOD_PRESALE_KEYS` (comma-separated). The bot checks every wallet's `walletInfo` / `depositable`
every `pollMs` (default 250 ms). When a wallet's whitelist batch lands and the whitelist round is open, it
calls `deposit()` with that wallet's remaining allocation, waits for the receipt and logs the `Deposited`
event. Each wallet deposits once. Wallets with no tier are never deposited from, so the bot will not
join the public round.

| field | meaning |
|---|---|
| `type` | `presale` |
| `contract` | the raise contract |
| `keysEnv` | env var holding the wallet keys (default `ROBINHOOD_PRESALE_KEYS`) |
| `buyAmount` | optional cap per wallet in ETH; omit it to fill the whole tier allocation |
| `pollMs` | eligibility check interval (default 250) |

In paper mode, each eligible wallet's deposit is simulated once and logged instead of sent. Each wallet
needs its allocation plus a little ETH for gas (deposit() uses ~94k gas). If you send more ETH than the
allocation, the contract refunds the extra.

## Safety

- Use dedicated hot wallets funded only with what you plan to spend. `.env` and `targets.json` are git-ignored.
- `once: true` (default) prevents repeat buys if a deployer launches more than one coin.
- There is no automatic selling.
