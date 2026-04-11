# openclaw-claude-proxy-auth

OpenClaw plugin that bypasses Anthropic's non-Claude-Code client detection for OAuth requests.

## What it does

Transforms outgoing Anthropic API requests via `wrapStreamFn` + `onPayload` to emulate Claude Code client identity:

1. **Billing header injection** — SHA-256 fingerprint-based `x-anthropic-billing-header` in `system[0]`
2. **System prompt stripping** — Reduces ~28KB OpenClaw config to short natural language paraphrase
3. **Tool name transformation** — `mcp_` prefix + 31 tool renames (e.g. `exec` → `mcp_Bash`)
4. **String sanitization** — 27 pattern replacements to remove OpenClaw fingerprints
5. **Claude Code headers** — `user-agent`, `x-app`, `x-stainless-*`, `anthropic-beta`
6. **OAuth Bearer auth** — Reads tokens from `~/.cli-proxy-api/claude-*.json`

## Install

```bash
cp -r . ~/.openclaw/plugins/openclaw-claude-proxy-auth/
```

Then configure a `claude-proxy` provider in `openclaw.json` pointing to `https://api.anthropic.com` with `api: "anthropic-messages"`.

## Requirements

- Node.js builtins only (`node:fs`, `node:path`, `node:os`, `node:crypto`)
- OAuth credentials at `~/.cli-proxy-api/claude-*.json` (managed by cli-proxy-api)
