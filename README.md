# spirit-cards-mcp

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
**Spirit Cards (Proof of Card)** — a proof-of-work minted collectible card game on
**Robinhood Chain** (chainId `46630`).

It runs over **stdio**, so [Claude Desktop](https://claude.ai/download) and Cursor can launch it
with `npx`. It fetches live game data from the hosted web API and computes the proof-of-work
**locally** with [viem](https://viem.sh) — so an agent can inspect the collection, verify a
nonce, or even **grind a valid nonce**, without a wallet, a private key, or a single transaction.

> **Read-only.** No keys, no secrets, no signing, no sending. Every network call is a plain GET.

---

## Quick start

### Run with npx (after publishing)

```bash
npx spirit-cards-mcp
```

### Run from source

```bash
npm install
node src/index.mjs      # starts the stdio server (logs to stderr)
```

The server speaks MCP over stdin/stdout and logs only to **stderr** — it is normally launched by
an MCP client, not by hand.

---

## Use in Claude Desktop

Add this to `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "spirit-cards": {
      "command": "npx",
      "args": ["-y", "spirit-cards-mcp"],
      "env": { "SPIRIT_CARDS_API": "https://quiet-atlas-2049.vercel.app" }
    }
  }
}
```

## Use in Cursor

Add this to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "spirit-cards": {
      "command": "npx",
      "args": ["-y", "spirit-cards-mcp"],
      "env": { "SPIRIT_CARDS_API": "https://quiet-atlas-2049.vercel.app" }
    }
  }
}
```

---

## Configuration

| Env var             | Default                              | Meaning                         |
| ------------------- | ------------------------------------ | ------------------------------- |
| `SPIRIT_CARDS_API`  | `https://quiet-atlas-2049.vercel.app` | Base URL of the hosted site/API |

All data endpoints are read-only GETs:

- `/.well-known/ai.json` — project descriptor (chain id, core contract, mechanics, links)
- `/stats/current.json` — live supply, price, required difficulty (`baseBits`), cooldown
- `/api/meta/{tokenId}` — card metadata
- `/api/points` — points leaderboard
- `/api/recent` — recent on-chain activity

---

## Tools

| Tool                  | Args                            | Description                                                             |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `get_project_info`    | —                               | `/.well-known/ai.json` + a composed human `summary`                     |
| `get_collection_stats`| —                               | Live stats: supply, price, `baseBits`, cooldown, paused flag            |
| `get_card`            | `tokenId`                       | Card metadata (`/api/meta/{tokenId}`)                                   |
| `get_leaderboard`     | `limit?` (default 25)           | Points leaderboard, trimmed to `limit`                                  |
| `get_recent_activity` | `limit?` (default 10)           | Recent events, trimmed to `limit`                                       |
| `verify_nonce`        | `miner`, `nonce`                | Verify a nonce's work locally (no tx): `{work, leadingZeroBits, valid}` |
| `find_nonce`          | `miner`, `maxAttempts?` (≤5M)   | Grind nonce 0.. until valid (~20 s wall cap)                            |
| `get_mining_guide`    | —                               | Step-by-step mint guide with live price/difficulty/cooldown             |

### Proof-of-work

A nonce is valid when:

```
work = keccak256(abi.encodePacked(uint256 chainId, address core, address miner, uint256 nonce))
leadingZeroBits(work) >= baseBits
```

Both `verify_nonce` and `find_nonce` compute this locally with viem's `keccak256` over
`concatHex([chainId, core, miner, nonce])` — byte-for-byte identical to Solidity's
`abi.encodePacked`.

## Prompts

| Prompt             | Args        | Description                                                    |
| ------------------ | ----------- | -------------------------------------------------------------- |
| `project_overview` | —           | Introduce the game to a newcomer (calls the info + stats tools) |
| `start_mining`     | `wallet?`   | Walk through finding a nonce and the exact mint transaction      |

---

## Hosted HTTP MCP

Prefer HTTP over stdio? The same server is also hosted at:

```
https://quiet-atlas-2049.vercel.app/api/mcp
```

---

## License

MIT © 2026 Spirit Cards (Proof of Card). See [LICENSE](./LICENSE).
