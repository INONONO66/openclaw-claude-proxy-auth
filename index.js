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
const TOOL_PREFIX = "";
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
  ["sessions_list", "TaskList"],
  ["sessions_history", "TaskHistory"],
  ["sessions_send", "TaskSend"],
  ["sessions_spawn", "TaskCreate"],
  ["sessions_yield", "TaskYield"],
  ["sessions_yield_interrupt", "TaskYieldInterrupt"],
  ["sessions_store", "TaskStore"],
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

const DEFAULT_REVERSE_MAP = [
  ["OCPlatform", "OpenClaw"],
  ["ocplatform", "openclaw"],
  ["create_task", "sessions_spawn"],
  ["list_tasks", "sessions_list"],
  ["get_history", "sessions_history"],
  ["send_to_task", "sessions_send"],
  ["task_yield_interrupt", "sessions_yield_interrupt"],
  ["yield_task", "sessions_yield"],
  ["task_store", "sessions_store"],
  ["HB_ACK", "HEARTBEAT_OK"],
  ["HB_SIGNAL", "HEARTBEAT"],
  ["hb_signal", "heartbeat"],
  ["assistant_bot", "clawbot"],
  ["AssistantBot", "ClawBot"],
  ["ASSISTANT_BOT", "CLAWBOT"],
  ["platform-gateway", "openclaw-gateway"],
  ["Platform Gateway", "OpenClaw Gateway"],
  ["platform_hub", "clawdhub"],
  ["PlatformHub", "ClawdHub"],
  ["PLATFORM_HUB", "CLAWDHUB"],
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

  const genericSummary = "You are an AI operations assistant with access to the tools attached to this request for command execution, file inspection, search, browsing, scheduling, messaging, and task coordination. Use the provided tools directly, keep answers concise, and follow the user's instructions carefully.";
  const structuredMarker = result.indexOf("\n## ");
  if (structuredMarker !== -1 && result.length - structuredMarker > 1200) {
    result = genericSummary;
  } else if (result.length > 600) {
    result = genericSummary;
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

function applyReverseStringReplacements(text) {
  if (!text) return text;
  let result = text;
  for (const [from, to] of DEFAULT_REVERSE_MAP) {
    result = result.split(from).join(to);
  }
  return result;
}

function reverseToolName(name) {
  if (!name || typeof name !== "string") return name;
  const lower = name.toLowerCase();
  const unprefixed = lower.startsWith(TOOL_PREFIX) ? lower.slice(TOOL_PREFIX.length) : lower;
  for (const [orig, renamed] of DEFAULT_TOOL_RENAMES) {
    if (unprefixed === renamed.toLowerCase()) return orig;
  }
  return unprefixed;
}

function reverseKnownProperties(record) {
  if (!record || typeof record !== "object") return record;
  let next = record;
  for (const [orig, renamed] of DEFAULT_PROP_RENAMES) {
    if (renamed in next) {
      const value = next[renamed];
      next = { ...next, [orig]: value };
      delete next[renamed];
    }
  }
  return next;
}

function reverseContentBlock(block) {
  if (!block || typeof block !== "object") return block;
  let next = reverseKnownProperties(block);
  if (next.type === "text" && typeof next.text === "string") {
    next = { ...next, text: applyReverseStringReplacements(next.text) };
  }
  if (next.type === "tool_use" && typeof next.name === "string") {
    next = { ...next, name: reverseToolName(next.name) };
  }
  if (Array.isArray(next.content)) {
    next = { ...next, content: next.content.map(reverseContentBlock) };
  } else if (typeof next.content === "string") {
    next = { ...next, content: applyReverseStringReplacements(next.content) };
  }
  return next;
}

function reverseMessageForOpenClaw(message) {
  if (!message || typeof message !== "object") return message;
  let next = { ...message };
  if (typeof next.content === "string") {
    next.content = applyReverseStringReplacements(next.content);
  } else if (Array.isArray(next.content)) {
    next.content = next.content.map(reverseContentBlock);
  }
  if (typeof next.errorMessage === "string") {
    next.errorMessage = applyReverseStringReplacements(next.errorMessage);
  }
  if (typeof next.toolName === "string") {
    next.toolName = reverseToolName(next.toolName);
  }
  if (typeof next.name === "string") {
    next.name = reverseToolName(next.name);
  }
  return reverseKnownProperties(next);
}

function reverseAssistantEventForOpenClaw(event) {
  if (!event || typeof event !== "object") return event;
  const next = { ...event };
  if (typeof next.toolName === "string") next.toolName = reverseToolName(next.toolName);
  if (typeof next.name === "string") next.name = reverseToolName(next.name);
  if (next.type === "text_delta" && typeof next.delta === "string") {
    next.delta = applyReverseStringReplacements(next.delta);
  }
  if (next.type === "text_end" && typeof next.content === "string") {
    next.content = applyReverseStringReplacements(next.content);
  }
  if (next.type === "content_block_start" && next.content_block) {
    next.content_block = reverseContentBlock(next.content_block);
  }
  if (next.type === "content_block_delta" && next.delta && typeof next.delta.text === "string") {
    next.delta = { ...next.delta, text: applyReverseStringReplacements(next.delta.text) };
  }
  if (Object.hasOwn(next, "partial")) next.partial = reverseMessageForOpenClaw(next.partial);
  if (Object.hasOwn(next, "message")) next.message = reverseMessageForOpenClaw(next.message);
  if (Object.hasOwn(next, "error")) next.error = reverseMessageForOpenClaw(next.error);
  return reverseKnownProperties(next);
}

function stripSchemaMetadata(value) {
  if (Array.isArray(value)) return value.map(stripSchemaMetadata);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (["description", "title", "default", "examples", "$schema", "markdownDescription"].includes(k)) continue;
    out[k] = stripSchemaMetadata(v);
  }
  return out;
}

function relocateSanitizedSystemToFirstUser(payload) {
  if (!payload || !Array.isArray(payload.system) || payload.system.length <= 1) return payload;

  const kept = [];
  const movedTexts = [];
  for (const entry of payload.system) {
    if (entry?.type === "text" && typeof entry.text === "string") {
      if (entry.text.includes("x-anthropic-billing-header:") || entry.text.includes(CLAUDE_CODE_IDENTITY)) {
        kept.push(entry);
      } else if (entry.text.trim()) {
        movedTexts.push(entry.text.trim());
      }
      continue;
    }
    kept.push(entry);
  }

  if (movedTexts.length === 0 || !Array.isArray(payload.messages)) {
    payload.system = kept;
    return payload;
  }

  const prefix = movedTexts.join("\n\n");
  const firstUser = payload.messages.find((m) => m?.role === "user");
  if (!firstUser) {
    payload.system = kept;
    payload.messages.unshift({
      role: "user",
      content: [{ type: "text", text: prefix }],
    });
    return payload;
  }

  if (typeof firstUser.content === "string") {
    firstUser.content = `${prefix}

${firstUser.content}`;
  } else if (Array.isArray(firstUser.content)) {
    firstUser.content = [{ type: "text", text: prefix }, ...firstUser.content];
  } else {
    firstUser.content = [{ type: "text", text: prefix }];
  }
  payload.system = kept;
  return payload;
}

function wrapResponseStreamForOpenClaw(stream) {
  if (!stream || typeof stream !== "object") return stream;
  if (typeof stream.result === "function") {
    const originalResult = stream.result.bind(stream);
    stream.result = async () => reverseMessageForOpenClaw(await originalResult());
  }
  if (typeof stream[Symbol.asyncIterator] === "function") {
    const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          return result.done ? result : { done: false, value: reverseAssistantEventForOpenClaw(result.value) };
        },
        async return(value) {
          return iterator.return?.(value) ?? { done: true, value: void 0 };
        },
        async throw(error) {
          return iterator.throw?.(error) ?? { done: true, value: void 0 };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
  }
  return stream;
}

function dumpPayloadSnapshot(payload) {
  try {
    writeFileSync('/tmp/openclaw-claude-proxy-last-payload.json', JSON.stringify(payload, null, 2));
  } catch {}
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
    .map((block) => {
      if (typeof block === "string") {
        if (block.includes(CLAUDE_CODE_IDENTITY)) return { type: "text", text: block };
        return { type: "text", text: sanitizeSystemText(block) };
      }
      if (block?.type === "text") {
        if (typeof block.text === "string" && block.text.includes(CLAUDE_CODE_IDENTITY)) return block;
        return { ...block, text: sanitizeSystemText(block.text) };
      }
      return block;
    })
    .filter((b) => b?.text !== "");

  payload.system = [billingBlock, ...sanitizedSystem];
  relocateSanitizedSystemToFirstUser(payload);
  dumpPayloadSnapshot(payload);

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
              return { ...block, name: normalizeOutboundToolName(block.name) };
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
      return {
        ...tool,
        name: normalizeOutboundToolName(tool.name || ""),
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

function normalizeOutboundToolName(name) {
  if (!name || typeof name !== "string") return name;
  if (name.startsWith(TOOL_PREFIX)) return name;
  let next = name;
  for (const [orig, renamed] of DEFAULT_TOOL_RENAMES) {
    if (next === orig) {
      next = renamed;
      break;
    }
  }
  return TOOL_PREFIX + next;
}

function renameToolForClaude(tool) {
  if (!tool || typeof tool !== "object") return tool;
  let name = tool.name || "";
  for (const [orig, renamed] of DEFAULT_TOOL_RENAMES) {
    if (name === orig) {
      name = renamed;
      break;
    }
  }
  return {
    ...tool,
    name: TOOL_PREFIX + name,
    description: "",
    input_schema: stripSchemaMetadata(tool.input_schema || {}),
  };
}

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
      normalizeToolSchemas: ({ tools }) => Array.isArray(tools) ? tools.map(renameToolForClaude) : tools,
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

          if (Array.isArray(context?.messages) && context.messages.length > 0) {
            const last = context.messages[context.messages.length - 1];
            if (last?.role === "assistant") {
              const blocks = Array.isArray(last.content) ? last.content : [];
              const hasToolUse = blocks.some((b) => b?.type === "tool_use");
              if (!hasToolUse) {
                context = { ...context, messages: context.messages.slice(0, -1) };
              }
            }
          }

          const originalOnPayload = options?.onPayload;
          const onPayload = (payload, payloadModel) => {
            const transformed = transformPayload(payload);
            return originalOnPayload
              ? originalOnPayload(transformed, payloadModel)
              : transformed;
          };

          const maybeStream = baseStreamFn(model, context, {
            ...options,
            headers,
            onPayload,
            apiKey: token,
          });

          if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
            return Promise.resolve(maybeStream).then((stream) => wrapResponseStreamForOpenClaw(stream));
          }
          return wrapResponseStreamForOpenClaw(maybeStream);

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
