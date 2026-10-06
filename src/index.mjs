#!/usr/bin/env node
// spirit-cards-mcp — read-only Model Context Protocol server for Spirit Cards
// (Proof of Card), the proof-of-work minted collectible card game on Robinhood
// Chain.
//
// Transport: stdio (newline-delimited JSON-RPC), launched by an MCP client.
// Data: fetched from the hosted web API (`SPIRIT_CARDS_API`).
// Proof-of-work: computed locally with viem's keccak256 — no keys, no txns.
//
// This server is strictly READ-ONLY. It never signs or sends a transaction.

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { keccak256, concatHex, toHex } from "viem";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_API = "https://spiritcards.fun";

/** Base URL of the hosted Spirit Cards site (no trailing slash). */
const API = (process.env.SPIRIT_CARDS_API || DEFAULT_API).replace(/\/+$/, "");

const DEFAULT_SITE = "https://spiritcards.fun";
const MINER_REPO = "github.com/spiritcards/spirit-cards";

// ---------------------------------------------------------------------------
// HTTP helpers (read-only GETs)
// ---------------------------------------------------------------------------

/**
 * GET `${API}${path}` and parse the JSON body.
 * @param {string} path
 * @param {{ allowStatus?: number[] }} [opts] HTTP statuses that should not throw.
 */
async function getJson(path, opts = {}) {
  const { allowStatus = [] } = opts;
  const url = API + path;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new Error(`Network error fetching ${url}: ${err?.message ?? err}`);
  }
  const text = await res.text();
  if (!res.ok && !allowStatus.includes(res.status)) {
    let detail = text.slice(0, 300) || res.statusText;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string") detail = parsed.error;
    } catch {
      /* keep raw text */
    }
    throw new Error(`GET ${path} -> HTTP ${res.status}: ${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GET ${path}: response was not valid JSON`);
  }
}

// ---------------------------------------------------------------------------
// Proof-of-work (matches the on-chain contract exactly)
//   work = keccak256(abi.encodePacked(uint256 chainId, address core, address miner, uint256 nonce))
//   valid iff leadingZeroBits(work) >= baseBits
// ---------------------------------------------------------------------------

/** Coerce a number|string input into a non-negative BigInt. */
function toBig(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`expected an integer, got ${value}`);
    return BigInt(value);
  }
  return BigInt(String(value).trim());
}

/**
 * keccak256 over the 104-byte packed preimage, as 0x-hex. `concatHex` reproduces
 * Solidity's `abi.encodePacked` (no padding between fields):
 *   [0..32) chainId | [32..52) core | [52..72) miner | [72..104) nonce
 */
function computeWork(chainId, core, miner, nonceBig) {
  const packed = concatHex([
    toHex(toBig(chainId), { size: 32 }),
    core,
    miner,
    toHex(toBig(nonceBig), { size: 32 }),
  ]);
  return keccak256(packed);
}

/** Count the leading zero bits of a 32-byte hash given as 0x-hex (all-zero => 256). */
function leadingZeroBits(hashHex) {
  const h = hashHex.startsWith("0x") ? hashHex.slice(2) : hashHex;
  let count = 0;
  for (let i = 0; i < h.length; i++) {
    const nib = parseInt(h[i], 16);
    if (nib === 0) {
      count += 4;
      continue;
    }
    count += Math.clz32(nib) - 28; // nib in 1..15 -> 3..0 extra leading bits
    return count;
  }
  return count; // digest was all zeroes -> 256
}

/** Resolve {chainId, core, requiredBits, site} from the live API. */
async function resolvePowContext() {
  const [ai, stats] = await Promise.all([
    getJson("/.well-known/ai.json"),
    getJson("/stats/current.json"),
  ]);
  const chainId = ai?.collection?.chain_id ?? stats?.chainId;
  const core = ai?.collection?.contracts?.core ?? stats?.contract;
  if (!chainId) throw new Error("live data is missing the chain id (collection.chain_id)");
  if (!core) throw new Error("live data is missing the core contract (collection.contracts.core)");
  const requiredBits = stats?.baseBits;
  if (typeof requiredBits !== "number") {
    throw new Error("live stats is missing baseBits (required PoW difficulty)");
  }
  return { chainId, core, requiredBits, site: ai?.site ?? DEFAULT_SITE, ai, stats };
}

const POW_RULE =
  "work = keccak256(abi.encodePacked(uint256 chainId, address core, address miner, uint256 nonce)); " +
  "a nonce is valid iff leadingZeroBits(work) >= baseBits";

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "spirit-cards", version: "0.1.0" });

/** Wrap a value as an MCP text-content result. */
function text(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const Z_ADDR = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");
const Z_NONCE = z.union([z.number().int().nonnegative(), z.string()]);

// 1. get_project_info -------------------------------------------------------
server.registerTool(
  "get_project_info",
  {
    title: "Get project info",
    description:
      "Fetch the Spirit Cards machine-readable project descriptor (/.well-known/ai.json) " +
      "plus a human summary of the game.",
    inputSchema: z.object({}),
  },
  async () => {
    const ai = await getJson("/.well-known/ai.json");
    const chainName = ai?.collection?.chain_name ?? "Robinhood Chain";
    const chainId = ai?.collection?.chain_id ?? "?";
    const gas = ai?.collection?.gas_token ?? "the native token";
    const site = ai?.site ?? DEFAULT_SITE;
    const summary =
      `Spirit Cards (Proof of Card) is a proof-of-work minted collectible card game on ${chainName} ` +
      `(chainId ${chainId}). Core loop: mine -> merge -> battle -> stake -> points. You "mine" by finding ` +
      `a nonce whose keccak256 hash has at least baseBits leading zero bits; a valid nonce becomes the ` +
      `card's on-chain seed. Then you merge cards, stake them in the vault, and battle other cards to earn ` +
      `points. Gas is paid in ${gas}. Home: ${site}` +
      (ai?.llms?.index ? ` (docs: ${ai.llms.index})` : "") +
      `.`;
    return text({ ...ai, summary });
  },
);

// 2. get_collection_stats ---------------------------------------------------
server.registerTool(
  "get_collection_stats",
  {
    title: "Get collection stats",
    description:
      "Live collection stats (/stats/current.json): supply, price, required PoW bits, cooldown, paused flag.",
    inputSchema: z.object({}),
  },
  async () => text(await getJson("/stats/current.json")),
);

// 3. get_card ---------------------------------------------------------------
server.registerTool(
  "get_card",
  {
    title: "Get card metadata",
    description: "Fetch on-chain card metadata for a tokenId (/api/meta/{tokenId}).",
    inputSchema: z.object({
      tokenId: z.coerce.number().int().nonnegative().describe("ERC-721 token id"),
    }),
  },
  async ({ tokenId }) => text(await getJson(`/api/meta/${tokenId}`, { allowStatus: [404] })),
);

// 4. get_leaderboard --------------------------------------------------------
server.registerTool(
  "get_leaderboard",
  {
    title: "Get points leaderboard",
    description: "Fetch the points leaderboard (/api/points), trimmed to `limit` wallets.",
    inputSchema: z.object({
      limit: z.number().int().positive().max(1000).optional().default(25),
    }),
  },
  async ({ limit }) => {
    const data = await getJson("/api/points");
    const wallets = Array.isArray(data?.wallets) ? data.wallets : [];
    return text({ ...data, wallets: wallets.slice(0, limit), returned: Math.min(limit, wallets.length) });
  },
);

// 5. get_recent_activity ----------------------------------------------------
server.registerTool(
  "get_recent_activity",
  {
    title: "Get recent activity",
    description: "Fetch recent on-chain events (/api/recent), trimmed to `limit` events.",
    inputSchema: z.object({
      limit: z.number().int().positive().max(1000).optional().default(10),
    }),
  },
  async ({ limit }) => {
    const data = await getJson("/api/recent");
    const events = Array.isArray(data?.events) ? data.events : [];
    return text({ ...data, events: events.slice(0, limit), returned: Math.min(limit, events.length) });
  },
);

// 6. get_pool ---------------------------------------------------------------
server.registerTool(
  "get_pool",
  {
    title: "Get staking pool",
    description:
      "Fetch the live staking-pool / emissions snapshot (/api/pool): accrued pool and house revenue, " +
      "the fee split shares, and the vault's total weight and undistributed rewards.",
    inputSchema: z.object({}),
  },
  async () => text(await getJson("/api/pool")),
);

// 7. verify_nonce -----------------------------------------------------------
server.registerTool(
  "verify_nonce",
  {
    title: "Verify a PoW nonce",
    description:
      "Locally compute keccak256(chainId || core || miner || nonce) and check whether its " +
      "leadingZeroBits reaches the live required difficulty. Read-only; no transaction is sent.",
    inputSchema: z.object({
      miner: Z_ADDR.describe("miner address used in the preimage"),
      nonce: Z_NONCE.describe("candidate nonce (integer or decimal string)"),
    }),
  },
  async ({ miner, nonce }) => {
    const { chainId, core, requiredBits } = await resolvePowContext();
    const nonceBig = toBig(nonce);
    const work = computeWork(chainId, core, miner, nonceBig);
    const bits = leadingZeroBits(work);
    return text({
      miner,
      nonce: nonceBig.toString(),
      work,
      leadingZeroBits: bits,
      requiredBits,
      valid: bits >= requiredBits,
    });
  },
);

// 8. find_nonce -------------------------------------------------------------
const FIND_NONCE_WALL_CAP_MS = 20_000;
const FIND_NONCE_MAX_ATTEMPTS_CAP = 5_000_000;

server.registerTool(
  "find_nonce",
  {
    title: "Find a valid PoW nonce",
    description:
      "Grind nonce = 0,1,2,... locally until leadingZeroBits(work) >= the live required difficulty. " +
      "Bounded by maxAttempts (default 1,000,000, hard cap 5,000,000) and a ~20s wall-clock cap. " +
      "Read-only; returns the nonce to submit to mine(); it does not send a transaction.",
    inputSchema: z.object({
      miner: Z_ADDR.describe("miner address used in the preimage"),
      maxAttempts: z.number().int().positive().max(FIND_NONCE_MAX_ATTEMPTS_CAP).optional().default(1_000_000),
    }),
  },
  async ({ miner, maxAttempts }) => {
    const { chainId, core, requiredBits } = await resolvePowContext();
    const cap = Math.min(maxAttempts, FIND_NONCE_MAX_ATTEMPTS_CAP);
    const started = Date.now();

    let found = false;
    let foundNonce = null;
    let foundWork = null;
    let foundBits = 0;
    let attempts = 0;

    for (let i = 0; i < cap; i++) {
      attempts = i + 1;
      const work = computeWork(chainId, core, miner, BigInt(i));
      const bits = leadingZeroBits(work);
      if (bits >= requiredBits) {
        found = true;
        foundNonce = BigInt(i);
        foundWork = work;
        foundBits = bits;
        break;
      }
      // Poll the wall clock periodically (cheap relative to a keccak round).
      if ((i & 1023) === 1023 && Date.now() - started >= FIND_NONCE_WALL_CAP_MS) break;
    }

    return text({
      miner,
      nonce: found ? foundNonce.toString() : null,
      work: found ? foundWork : null,
      leadingZeroBits: found ? foundBits : null,
      requiredBits,
      attempts,
      elapsedMs: Date.now() - started,
      found,
    });
  },
);

// 9. get_mining_guide -------------------------------------------------------
server.registerTool(
  "get_mining_guide",
  {
    title: "Get the mining guide",
    description:
      "Step-by-step guide to mint a Spirit Card: the PoW rule, live difficulty/price/cooldown, " +
      "the exact contract call, and where to get the miner.",
    inputSchema: z.object({}),
  },
  async () => {
    const { chainId, core, site, stats } = await resolvePowContext();
    const siteUrl = site ?? DEFAULT_SITE;
    return text({
      game: "Spirit Cards (Proof of Card)",
      rule: POW_RULE,
      chainId,
      core,
      live: {
        requiredBits: stats?.baseBits,
        currentPriceEth: stats?.currentPriceEth,
        mineCooldownSeconds: stats?.mineCooldownSeconds,
        paused: stats?.paused,
        totalMinted: stats?.totalMinted,
        maxSupply: stats?.maxSupply,
      },
      steps: [
        "Put your own miner address in the preimage — only that address can claim the mint.",
        `Use find_nonce(miner, ...) to search for a nonce whose work has >= ${stats?.baseBits ?? "baseBits"} leading zero bits.`,
        `Call the core contract ${core} on chainId ${chainId} with mine(uint256 nonce, bool useChip) payable.`,
        `Set msg.value to exactly currentPrice() (live: ${stats?.currentPriceEth ?? "?"} ETH) — it is discounted when useChip is true and you hold a chip.`,
        `Respect the cooldown of ${stats?.mineCooldownSeconds ?? "?"}s between mints from the same address.`,
        "Verify before spending: call verify_nonce(miner, nonce) to confirm the nonce is still valid.",
      ],
      contractCall: {
        signature: "mine(uint256 nonce, bool useChip) payable",
        value: "msg.value == currentPrice()",
        note: "The stored card seed is the work hash of your accepted nonce.",
      },
      miner: {
        site: `${siteUrl}/mine`,
        cli: `${MINER_REPO} (see the miner/ directory)`,
      },
      hint: "Call find_nonce with your wallet address to get a valid nonce, then submit it to mine().",
      links: {
        site: siteUrl,
        explorer: `https://explorer.testnet.chain.robinhood.com/address/${core}`,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

// 10. project_overview ------------------------------------------------------
server.registerPrompt(
  "project_overview",
  {
    title: "Project overview",
    description: "Introduce Spirit Cards to a newcomer.",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Call the `get_project_info` tool and then the `get_collection_stats` tool. " +
            "Using only their results, write a short, welcoming introduction to Spirit Cards " +
            "(Proof of Card): what it is, the mine -> merge -> battle -> stake -> points loop, " +
            "the chain it runs on and the gas token, the current supply/price/difficulty, and " +
            "where to learn more. Keep it concise and accurate — do not invent numbers.",
        },
      },
    ],
  }),
);

// 11. start_mining ----------------------------------------------------------
server.registerPrompt(
  "start_mining",
  {
    title: "Start mining",
    description: "Guide the user through finding a nonce and minting a card.",
    argsSchema: z.object({
      wallet: z.string().optional().describe("your miner/EOA address (optional)"),
    }),
  },
  ({ wallet }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Help me mint a Spirit Card.\n" +
            "1. Call `get_mining_guide` and read the PoW rule, the live difficulty, price and cooldown.\n" +
            "2. Call `find_nonce`" +
            (wallet ? ` with miner = \`${wallet}\`` : " with my wallet address (ask me for it if you need it)") +
            " to search for a valid nonce.\n" +
            "3. Explain the exact mint transaction: call `mine(uint256 nonce, bool useChip) payable` on the core " +
            "contract, with `msg.value == currentPrice()` and the cooldown respected — using the nonce you found.\n" +
            "Be explicit about the address, the value to send, and the risk of an invalid or expired nonce.",
        },
      },
    ],
  }),
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // STDOUT is reserved for JSON-RPC; log diagnostics to STDERR only.
  console.error(`spirit-cards-mcp 0.1.0 ready (stdio). API base: ${API}`);
}

main().catch((err) => {
  console.error("spirit-cards-mcp failed to start:", err);
  process.exit(1);
});
