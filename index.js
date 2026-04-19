import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

// === CONSTANTS ===
// Last synced from opencode-anthropic-auth@1.4.0 + openclaw-billing-proxy@2.2.4 on 2026-04-10
const CC_VERSION = "2.1.97";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const BILLING_HASH_SALT = "59cf53e54c78";
const BILLING_HASH_INDICES = [4, 7, 20];
const TOOL_PREFIX = "mcp_";
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const OPENCODE_IDENTITY =
  "You are OpenCode, the best coding agent on the planet.";
const PARAGRAPH_REMOVAL_ANCHORS = [
  "github.com/anomalyco/opencode",
  "opencode.ai/docs",
];
const REQUIRED_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "context-management-2025-06-27",
];
const USER_AGENT = `claude-cli/${CC_VERSION} (external, cli)`;
const INSTANCE_SESSION_ID = randomUUID();
const PROVIDER_ID = "claude-proxy";

// String replacements: [from, to] — applied to system/message text
// Source: openclaw-billing-proxy DEFAULT_REPLACEMENTS
const DEFAULT_REPLACEMENTS = [
  ["OpenClaw", "OCPlatform"],
  ["openclaw", "ocplatform"],
  ["sessions_spawn", "create_task"],
  ["sessions_list", "list_tasks"],
  ["sessions_history", "get_history"],
  ["sessions_send", "send_to_task"],
  ["sessions_yield_interrupt", "task_yield_interrupt"],
  ["sessions_yield", "yield_task"],
  ["sessions_store", "task_store"],
  ["HEARTBEAT_OK", "HB_ACK"],
  ["HEARTBEAT", "HB_SIGNAL"],
  ["heartbeat", "hb_signal"],
  ["running inside", "operating from"],
  ["I am running inside", "I am operating from"],
  ["You are running inside", "You are operating from"],
  ["agent is running inside", "agent is operating from"],
  ["clawbot", "assistant_bot"],
  ["ClawBot", "AssistantBot"],
  ["CLAWBOT", "ASSISTANT_BOT"],
  ["openclaw-gateway", "platform-gateway"],
  ["OpenClaw Gateway", "Platform Gateway"],
  ["clawdhub", "platform_hub"],
  ["ClawdHub", "PlatformHub"],
  ["CLAWDHUB", "PLATFORM_HUB"],
  ["if OpenCode honestly", "if the assistant honestly"],
  ["if openclaw honestly", "if the assistant honestly"],
  ["if OCPlatform honestly", "if the assistant honestly"],
];

// Tool name renames: [original, renamed] — applied to tools[].name
// Source: openclaw-billing-proxy DEFAULT_TOOL_RENAMES
const DEFAULT_TOOL_RENAMES = [
  ["exec", "Bash"],
  ["process", "BashSession"],
  ["browser", "BrowserControl"],
  ["canvas", "CanvasView"],
  ["nodes", "DeviceControl"],
  ["cron", "Scheduler"],
  ["message", "SendMessage"],
  ["tts", "Speech"],
  ["gateway", "SystemCtl"],
  ["agents_list", "AgentList"],
  ["list_tasks", "TaskList"],
  ["get_history", "TaskHistory"],
  ["send_to_task", "TaskSend"],
  ["create_task", "TaskCreate"],
  ["subagents", "AgentControl"],
  ["session_status", "StatusCheck"],
  ["web_search", "WebSearch"],
  ["web_fetch", "WebFetch"],
  ["pdf", "PdfParse"],
  ["image_generate", "ImageCreate"],
  ["music_generate", "MusicCreate"],
  ["video_generate", "VideoCreate"],
  ["memory_search", "KnowledgeSearch"],
  ["memory_get", "KnowledgeGet"],
  ["lcm_expand_query", "ContextQuery"],
  ["lcm_grep", "ContextGrep"],
  ["lcm_describe", "ContextDescribe"],
  ["lcm_expand", "ContextExpand"],
  ["yield_task", "TaskYield"],
  ["task_store", "TaskStore"],
  ["task_yield_interrupt", "TaskYieldInterrupt"],
];

// Property name renames: [original, renamed]
// Source: openclaw-billing-proxy DEFAULT_PROP_RENAMES
const DEFAULT_PROP_RENAMES = [
  ["session_id", "thread_id"],
  ["conversation_id", "thread_ref"],
  ["summaryIds", "chunk_ids"],
  ["summary_id", "chunk_id"],
  ["system_event", "event_text"],
  ["agent_id", "worker_id"],
  ["wake_at", "trigger_at"],
  ["wake_event", "trigger_event"],
];

// === CREDENTIAL MANAGEMENT ===

let cachedCredential = null;
let refreshPromise = null;
let currentCredIndex = 0;

function findAllCredentialFiles() {
  const dir = join(homedir(), ".cli-proxy-api");
  try {
    const files = readdirSync(dir);
    return files
      .filter((f) => f.startsWith("claude-") && f.endsWith(".json"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function loadCredentialFromFile(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (data.disabled) return null;
  return { ...data, _file: file };
}

function reloadCredentialFromDisk(file) {
  try {
    const fresh = loadCredentialFromFile(file);
    if (fresh && !isExpired(fresh)) {
      cachedCredential = fresh;
      return fresh;
    }
  } catch { /* file may not exist anymore */ }
  return null;
}

function loadCredential() {
  const files = findAllCredentialFiles();
  if (files.length === 0)
    throw new Error("No credential file in ~/.cli-proxy-api/");

  // Try current index first, then rotate through all files
  for (let i = 0; i < files.length; i++) {
    const idx = (currentCredIndex + i) % files.length;
    try {
      const cred = loadCredentialFromFile(files[idx]);
      if (cred) {
        currentCredIndex = idx;
        cachedCredential = cred;
        return cred;
      }
    } catch { continue; }
  }
  // Fallback: load first file regardless
  const data = JSON.parse(readFileSync(files[0], "utf8"));
  cachedCredential = { ...data, _file: files[0] };
  return cachedCredential;
}

function isExpired(cred) {
  if (!cred?.expired) return true;
  const expiry = new Date(cred.expired).getTime();
  return Date.now() > expiry - 5 * 60 * 1000;
}

async function refreshSingleToken(cred) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: cred.refresh_token,
      client_id: CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const now = new Date();
  const expiresIn = data.expires_in || 3600;
  const expiry = new Date(now.getTime() + expiresIn * 1000);

  const updated = {
    ...cred,
    access_token: data.access_token,
    refresh_token: data.refresh_token || cred.refresh_token,
    expired: expiry.toISOString(),
    last_refresh: now.toISOString(),
  };

  delete updated._file;
  writeFileSync(cred._file, JSON.stringify(updated, null, 2));

  return { ...updated, _file: cred._file };
}

async function refreshToken(cred) {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      // Step 1: Check if another process (cli-proxy-api) already refreshed
      const reloaded = reloadCredentialFromDisk(cred._file);
      if (reloaded) return reloaded;

      // Step 2: Try refreshing this credential
      try {
        const result = await refreshSingleToken(cred);
        cachedCredential = result;
        return result;
      } catch (err) {
        console.error(
          `[claude-proxy-auth] Refresh failed for ${cred.email || cred._file}: ${err.message}`
        );

        // Step 3: Fallback — try other credential files
        const allFiles = findAllCredentialFiles();
        for (const file of allFiles) {
          if (file === cred._file) continue;
          try {
            // First check if it's already fresh on disk
            const alt = loadCredentialFromFile(file);
            if (!alt) continue;
            if (!isExpired(alt)) {
              console.error(
                `[claude-proxy-auth] Fallback to fresh credential: ${alt.email || file}`
              );
              cachedCredential = alt;
              return alt;
            }
            // Try refreshing the alternative
            const refreshed = await refreshSingleToken(alt);
            console.error(
              `[claude-proxy-auth] Fallback refresh succeeded: ${refreshed.email || file}`
            );
            cachedCredential = refreshed;
            return refreshed;
          } catch (altErr) {
            console.error(
              `[claude-proxy-auth] Fallback also failed for ${file}: ${altErr.message}`
            );
            continue;
          }
        }

        throw err; // All credentials exhausted
      }
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function ensureFreshToken() {
  let cred = cachedCredential || loadCredential();

  // Always re-read from disk to pick up tokens refreshed by cli-proxy-api
  if (cred?._file) {
    const diskCred = reloadCredentialFromDisk(cred._file);
    if (diskCred) cred = diskCred;
  }

  if (isExpired(cred)) {
    cred = await refreshToken(cred);
  }
  return cred.access_token;
}

// === BILLING HEADER ===
// Source: openclaw-billing-proxy computeBillingFingerprint + buildBillingBlock

function computeBillingFingerprint(firstUserText) {
  const chars = BILLING_HASH_INDICES.map(
    (i) => firstUserText[i] || "0"
  ).join("");
  const input = `${BILLING_HASH_SALT}${chars}${CC_VERSION}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

function buildBillingBlock(messages) {
  const firstUser = (messages || []).find((m) => m.role === "user");
  let firstText = "";
  if (firstUser) {
    if (typeof firstUser.content === "string") {
      firstText = firstUser.content;
    } else if (Array.isArray(firstUser.content)) {
      const textBlock = firstUser.content.find((b) => b.type === "text");
      firstText = textBlock?.text || "";
    }
  }
  const fingerprint = computeBillingFingerprint(firstText);
  const ccVersion = `${CC_VERSION}.${fingerprint}`;
  return {
    type: "text",
    text: `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=cli; cch=00000;`,
  };
}

// === PAYLOAD TRANSFORMATION ===
// Source: opencode-anthropic-auth transform.ts + openclaw-billing-proxy processBody

function sanitizeSystemText(text) {
  if (!text) return text;

  let result = text.replace(OPENCODE_IDENTITY, "");

  const paragraphs = result.split(/\n\n+/);
  const filtered = paragraphs.filter(
    (p) => !PARAGRAPH_REMOVAL_ANCHORS.some((anchor) => p.includes(anchor))
  );
  result = filtered.join("\n\n");

  for (const [from, to] of DEFAULT_REPLACEMENTS) {
    result = result.split(from).join(to);
  }

  // Strip large structured system config (>2000 chars) — keep first paragraph + short paraphrase
  if (result.length > 2000) {
    const firstParagraphEnd = result.indexOf("\n\n");
    if (firstParagraphEnd > 0) {
      const firstParagraph = result.slice(0, firstParagraphEnd).trim();
      result =
        firstParagraph +
        "\n\nYou have access to various tools to help complete tasks. " +
        "Use them as needed to assist the user effectively. " +
        "Follow the user's instructions carefully and provide helpful, accurate responses.";
    }
  }

  return result.trim();
}

function applyStringReplacements(text) {
  if (!text) return text;
  let result = text;
  for (const [from, to] of DEFAULT_REPLACEMENTS) {
    result = result.split(from).join(to);
  }
  return result;
}

function transformPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

  // 1. Build billing block
  const billingBlock = buildBillingBlock(payload.messages);

  // pi-ai already set system[0] = Claude Code identity.
  // Prepend billing block, sanitize system[1+] only.
  const rawSystem = payload.system;
  const existingSystem = Array.isArray(rawSystem)
    ? rawSystem
    : rawSystem
      ? [rawSystem]
      : [];
  const sanitizedSystem = existingSystem
    .map((block, i) => {
      if (i === 0) return block;
      if (typeof block === "string")
        return { type: "text", text: sanitizeSystemText(block) };
      if (block?.type === "text")
        return { ...block, text: sanitizeSystemText(block.text) };
      return block;
    })
    .filter((b) => b?.text !== "");

  payload.system = [billingBlock, ...sanitizedSystem];

  // 3. Apply string replacements to messages
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.map((msg) => {
      if (!msg) return msg;
      if (typeof msg.content === "string") {
        return { ...msg, content: applyStringReplacements(msg.content) };
      }
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((block) => {
            if (!block) return block;
            if (block.type === "text") {
              return {
                ...block,
                text: applyStringReplacements(block.text),
              };
            }
            // Rename tool_use names
            if (block.type === "tool_use" && block.name) {
              let name = TOOL_PREFIX + block.name;
              for (const [orig, renamed] of DEFAULT_TOOL_RENAMES) {
                if (block.name === orig) {
                  name = TOOL_PREFIX + renamed;
                  break;
                }
              }
              return { ...block, name };
            }
            // Rename tool_result tool names
            if (block.type === "tool_result" && block.tool_use_id) {
              // tool_result doesn't carry a name, pass through
              return block;
            }
            return block;
          }),
        };
      }
      return msg;
    });
  }

  // 4. Transform tools: rename + prefix names + strip descriptions
  if (Array.isArray(payload.tools)) {
    payload.tools = payload.tools.map((tool) => {
      if (!tool) return tool;
      let name = tool.name || "";
      // Apply tool renames first, then prefix
      for (const [orig, renamed] of DEFAULT_TOOL_RENAMES) {
        if (name === orig) {
          name = renamed;
          break;
        }
      }
      name = TOOL_PREFIX + name;
      return {
        ...tool,
        name,
        description: "", // strip descriptions to reduce fingerprint signal
      };
    });
  }

  // 5. Rename known properties in messages
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.map((msg) => {
      if (!msg) return msg;
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((block) => {
            if (!block || typeof block !== "object") return block;
            let patched = block;
            for (const [orig, renamed] of DEFAULT_PROP_RENAMES) {
              if (orig in patched) {
                const val = patched[orig];
                patched = { ...patched, [renamed]: val };
                delete patched[orig];
              }
            }
            return patched;
          }),
        };
      }
      return msg;
    });
  }

  // 6. Sanitize trailing assistant messages for OAuth compatibility
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    const last = payload.messages[payload.messages.length - 1];
    if (last?.role === "assistant") {
      const blocks = Array.isArray(last.content) ? last.content : [];
      const hasToolUse = blocks.some(b => b?.type === "tool_use");
      const hasText = blocks.some(b => b?.type === "text" && b.text?.trim());

      if (!hasToolUse && !hasText) {
        // Empty or whitespace-only assistant message — remove
        payload.messages = payload.messages.slice(0, -1);
      } else if (!hasToolUse) {
        // Pure text prefill without tool_use — OAuth rejects this
        payload.messages = payload.messages.slice(0, -1);
      }
      // If hasToolUse: keep it — it's real conversation history
    }

    // 7. Repair orphaned tool_use: ensure every tool_use has a matching tool_result
    for (let i = 0; i < payload.messages.length - 1; i++) {
      const msg = payload.messages[i];
      if (msg?.role !== "assistant") continue;
      const toolUseBlocks = (Array.isArray(msg.content) ? msg.content : [])
        .filter(b => b?.type === "tool_use");
      if (toolUseBlocks.length === 0) continue;

      const nextMsg = payload.messages[i + 1];
      const nextBlocks = Array.isArray(nextMsg?.content) ? nextMsg.content : [];
      const resultIds = new Set(
        nextBlocks.filter(b => b?.type === "tool_result").map(b => b.tool_use_id)
      );

      const orphaned = toolUseBlocks.filter(b => !resultIds.has(b.id));
      if (orphaned.length > 0 && nextMsg?.role === "user") {
        const syntheticResults = orphaned.map(b => ({
          type: "tool_result",
          tool_use_id: b.id,
          content: "[tool result unavailable — session resumed]",
          is_error: true,
        }));
        nextMsg.content = [...syntheticResults, ...nextBlocks];
      }
    }
  }

  return payload;
}

// === RESPONSE STREAM REWRITING ===
// NOTE: Response-side reverse mapping is not implemented here.
// The AssistantMessageEventStream class (pi-ai) requires its own push()/end() protocol;
// wrapping it as a plain AsyncIterable crashes OpenClaw. Tool names in responses
// will carry the mcp_ prefix, which is cosmetic and does not affect functionality.
// The critical bypass layers (billing header, system prompt stripping, tool prefix
// in requests, Claude Code headers) are all implemented in transformPayload + wrapStreamFn.

// === HEADER BUILDING ===
// Source: openclaw-billing-proxy getStainlessHeaders + opencode-anthropic-auth setOAuthHeaders

function buildClaudeCodeHeaders(token) {
  const p = process.platform;
  const osName =
    p === "darwin"
      ? "macOS"
      : p === "win32"
        ? "Windows"
        : p === "linux"
          ? "Linux"
          : p;
  const arch =
    process.arch === "x64"
      ? "x64"
      : process.arch === "arm64"
        ? "arm64"
        : process.arch;
  return {
    authorization: `Bearer ${token}`,
    "user-agent": USER_AGENT,
    "x-app": "cli",
    "x-claude-code-session-id": INSTANCE_SESSION_ID,
    "x-stainless-arch": arch,
    "x-stainless-lang": "js",
    "x-stainless-os": osName,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
    "anthropic-beta": REQUIRED_BETAS.join(","),
    "anthropic-dangerous-direct-browser-access": "true",
    // Remove x-api-key by setting empty — provider will use authorization instead
    "x-api-key": "",
  };
}

// === PLUGIN EXPORT ===

export default {
  id: "claude-proxy-auth",
  name: "Claude Proxy Auth",
  description:
    "Anthropic OAuth proxy using Claude Code identity for subscription quota",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Claude Proxy (OAuth)",
      docsPath: "/providers/models",
      envVars: [],
      auth: [],
      resolveSyntheticAuth: () => {
        try {
          const cred = cachedCredential || loadCredential();
          if (isExpired(cred)) {
            ensureFreshToken().catch(() => {});
          }
          return {
            apiKey: cred.access_token,
            source: "Claude Proxy OAuth",
            mode: "oauth",
          };
        } catch {
          return undefined;
        }
      },
      wrapStreamFn: (ctx) => {
        const baseStreamFn = ctx.streamFn;
        return async (model, context, options) => {
          let token;
          try {
            token = await ensureFreshToken();
          } catch (err) {
            console.error(
              "[claude-proxy-auth] Token error:",
              err.message
            );
            return baseStreamFn(model, context, options);
          }

          const headers = buildClaudeCodeHeaders(token);
          const originalOnPayload = options?.onPayload;

          const onPayload = (payload, payloadModel) => {
            const transformed = transformPayload(payload);

            if (transformed && Array.isArray(transformed.messages)) {
              const lastMsg = transformed.messages[transformed.messages.length - 1];
              // transformPayload already handles prefill stripping and orphan repair
            }

            return originalOnPayload
              ? originalOnPayload(transformed, payloadModel)
              : transformed;
          };

          return baseStreamFn(model, context, {
            ...options,
            headers,
            onPayload,
            apiKey: token,
          });

        };
      },
      isCacheTtlEligible: () => true,
      resolveReasoningOutputMode: () => "native",
      resolveDefaultThinkingLevel: ({ modelId }) => {
        const lower = (modelId || "").toLowerCase();
        if (
          lower.startsWith("claude-opus-4") ||
          lower.startsWith("claude-sonnet-4")
        ) {
          return "adaptive";
        }
        return undefined;
      },
      isModernModelRef: ({ modelId }) => {
        const lower = (modelId || "").toLowerCase();
        return (
          lower.startsWith("claude-opus-4") ||
          lower.startsWith("claude-sonnet-4") ||
          lower.startsWith("claude-haiku-4")
        );
      },
    });
  },
};
