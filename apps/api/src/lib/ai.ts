import type { AiSetting } from "@prisma/client";
import { decryptSecret } from "./encryption.js";
import { prisma } from "./prisma.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const REQUEST_TIMEOUT_MS = 60_000;

/** How many prior turns are replayed as context. Keeps prompt cost bounded. */
export const CONTEXT_MESSAGE_LIMIT = 20;

export const DEFAULT_SYSTEM_PROMPT = [
  "You are Onshell Assistant, the in-product AI helper for Onshell.cloud — a browser-based SSH, SFTP, and RDP workspace for teams.",
  "",
  "Help users with:",
  "- Onshell.cloud itself: registering hosts, the credential vault, opening SSH/SFTP/RDP sessions, snippets, roles and permissions, audit logs, plans and billing.",
  "- Practical Linux, shell, and SSH work: commands, config files, key management, permissions, systemd, networking, Docker, and troubleshooting.",
  "",
  "Rules:",
  "- Be concise and practical. Lead with the command or the answer, then explain briefly.",
  "- Use fenced code blocks for commands and config, and say which file a snippet belongs in.",
  "- Never ask for, repeat, or store passwords, private keys, or other secrets. If a user pastes one, tell them to rotate it and do not echo it back.",
  "- Flag destructive commands (rm -rf, dd, mkfs, iptables -F, DROP TABLE) before giving them, and suggest the safe/dry-run form first.",
  "- If something depends on the user's plan or permissions, say so and point to the relevant part of the console.",
  "- If you do not know, say so instead of guessing at Onshell.cloud behaviour."
].join("\n");

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCompletion {
  content: string;
  model: string;
  promptTokens?: number;
  outputTokens?: number;
}

export class AiConfigurationError extends Error {
  constructor(
    message: string,
    readonly code: "ai_disabled" | "ai_key_missing"
  ) {
    super(message);
    this.name = "AiConfigurationError";
  }
}

export class AiUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "AiUpstreamError";
  }
}

export async function getAiSetting() {
  return prisma.aiSetting.findUnique({ where: { id: "global" } });
}

/** Browser-safe view: whether the assistant is usable, and under what model. */
export async function getPublicAiConfig() {
  const setting = await getAiSetting();
  const configured = Boolean(setting?.enabled && setting.encryptedApiKey);

  return {
    enabled: configured,
    model: configured ? (setting?.model ?? null) : null,
    monthlyMessageCap: setting?.monthlyMessageCap ?? 0
  };
}

function resolveApiKey(setting: AiSetting, masterEncryptionKey: string) {
  if (!setting.encryptedApiKey || !setting.apiKeyNonce || !setting.apiKeyAuthTag) return undefined;

  return decryptSecret(
    {
      encryptedPayload: setting.encryptedApiKey,
      nonce: setting.apiKeyNonce,
      authTag: setting.apiKeyAuthTag
    },
    masterEncryptionKey
  );
}

/**
 * Calls the OpenAI Chat Completions API with the admin-configured model and key.
 *
 * The key is decrypted per request and never leaves this module — the browser
 * talks only to our own /ai routes, so a compromised frontend cannot exfiltrate
 * the credential.
 */
export async function createAiCompletion(input: {
  messages: AiChatMessage[];
  masterEncryptionKey: string;
  /** Overrides the stored system prompt; used for one-off summarisation calls. */
  systemPrompt?: string;
  maxOutputTokens?: number;
}): Promise<AiCompletion> {
  const setting = await getAiSetting();
  if (!setting?.enabled) {
    throw new AiConfigurationError("The AI assistant is not enabled.", "ai_disabled");
  }

  const apiKey = resolveApiKey(setting, input.masterEncryptionKey);
  if (!apiKey) {
    throw new AiConfigurationError("No AI provider API key is configured.", "ai_key_missing");
  }

  const baseUrl = (setting.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const systemPrompt = input.systemPrompt ?? setting.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: setting.model,
      // Stored as an integer percentage so the column stays an Int.
      temperature: Math.min(Math.max(setting.temperature, 0), 200) / 100,
      max_tokens: input.maxOutputTokens ?? setting.maxOutputTokens,
      messages: [{ role: "system", content: systemPrompt }, ...input.messages]
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    // Surface the status but not the provider's body, which can echo the key.
    throw new AiUpstreamError(`AI provider returned ${response.status}`, response.status);
  }

  const payload = (await response.json()) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new AiUpstreamError("AI provider returned an empty completion", 502);
  }

  return {
    content,
    model: payload.model ?? setting.model,
    promptTokens: payload.usage?.prompt_tokens,
    outputTokens: payload.usage?.completion_tokens
  };
}

/** Derives a short thread title from the opening question, without an extra API call. */
export function deriveThreadTitle(firstMessage: string) {
  const cleaned = firstMessage.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 60) return cleaned || "New conversation";
  return `${cleaned.slice(0, 57).trimEnd()}…`;
}
