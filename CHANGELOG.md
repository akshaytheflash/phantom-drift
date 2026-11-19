# Changelog

## 0.1.0

First release.

- `observe` snapshots instructions, tools, resources, resource templates, prompts and prompt bodies
  from a stdio MCP server and appends a signed observation to a per server ledger.
- `proxy` runs the server behind a transparent stdio bridge and records an observation per session.
- Drift classification into `identical`, `cosmetic`, `expanding`, `reductive`, `rewriting`, `marked`
  and `self-licensed`.
- Phantom markers in HTML comments and Unicode tag characters, optionally bound to the previous
  digest.
- `taint` and `untaint`, with continuation detection for payloads that return after being removed and
  reappear on another surface.
- `verify` recomputes the HMAC chain and rejects edited, deleted, reordered or appended entries.
- Config discovery for OpenCode, Claude Code, VS Code, Claude Desktop and plain `mcpServers` files,
  including JSONC comments, trailing commas and `${VAR}` expansion.
