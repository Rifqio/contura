import type { AiAccess, AiProviderKind, AiSyncMode, ContextInfo, ContextStatusRow } from "../../api/types";
import { agoText } from "../../format/units";

export interface Preset {
  url: string;
  models: string[];
}

export interface ProviderInfo {
  name: string;
  sub: string;
  /** A short badge such as "Free tier". */
  badge?: string;
  /** Named endpoints for providers that front several; each has its own URL and models. */
  presets?: Record<string, Preset>;
  url: string;
  models: string[];
  keyHint: string;
  console: string;
}

const OPENAI_PRESETS: Record<string, Preset> = {
  OpenAI: {
    url: "https://api.openai.com/v1",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "o4-mini"],
  },
  OpenRouter: {
    url: "https://openrouter.ai/api/v1",
    models: [
      "openrouter/auto",
      "anthropic/claude-sonnet-4.5",
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.3-70b-instruct",
    ],
  },
  "Together AI": {
    url: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-Coder-32B-Instruct"],
  },
};

export const PROVIDERS: Record<AiProviderKind, ProviderInfo> = {
  openai: {
    name: "OpenAI-compatible",
    sub: "Any server that speaks the OpenAI API",
    presets: OPENAI_PRESETS,
    url: OPENAI_PRESETS.OpenAI.url,
    models: OPENAI_PRESETS.OpenAI.models,
    keyHint: "sk-…",
    console: "your provider's dashboard",
  },
  anthropic: {
    name: "Anthropic Claude",
    sub: "Claude models from Anthropic",
    url: "https://api.anthropic.com",
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
    keyHint: "sk-ant-…",
    console: "console.anthropic.com",
  },
  groq: {
    name: "Groq",
    sub: "Fast open models",
    badge: "Free tier",
    url: "https://api.groq.com/openai/v1",
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"],
    keyHint: "gsk_…",
    console: "console.groq.com/keys",
  },
  deepseek: {
    name: "DeepSeek",
    sub: "OpenAI-compatible API",
    badge: "Low cost",
    url: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyHint: "sk-…",
    console: "platform.deepseek.com",
  },
  custom: {
    name: "Custom",
    sub: "Self-hosted or local, e.g. Ollama or LM Studio",
    badge: "Runs locally",
    url: "http://127.0.0.1:11434/v1",
    models: ["qwen2.5-coder:7b", "llama3.1:8b"],
    keyHint: "Optional for local servers",
    console: "the server's settings",
  },
};

export const PROVIDER_ORDER: AiProviderKind[] = ["openai", "anthropic", "groq", "deepseek", "custom"];

/** The endpoint and models a provider (and preset, for OpenAI-compatible) starts from. */
export function providerDefaults(kind: AiProviderKind, preset: string | null): Preset {
  const p = PROVIDERS[kind];
  const chosen = p.presets && preset ? p.presets[preset] : undefined;
  return chosen ?? { url: p.url, models: p.models };
}

/**
 * A context window for the model facts: `1M`, `200K`, `131K`, `8K`. Millions keep one decimal
 * only when it is not whole (`1.5M`); thousands are always whole.
 */
export function formatWindow(tokens: number): string {
  const short = (v: number, digits: number) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
  // 999,600 rounds to 1,000K, so it reads 1M.
  if (tokens >= 999_500) return `${short(tokens / 1_000_000, 1)}M`;
  if (tokens >= 1000) return `${short(tokens / 1000, 0)}K`;
  return tokens.toLocaleString("en-US");
}

export const AI_ACCESS_OPTIONS: { value: AiAccess; label: string; description: string }[] = [
  { value: "never", label: "Never send anything", description: "Nothing" },
  { value: "schema", label: "Schema only", description: "Table and column names" },
  { value: "schemaQuery", label: "Schema and query text", description: "Table and column names and the text of your queries" },
  {
    value: "schemaQueryRows",
    label: "Schema, query text and sample rows",
    description: "Table and column names, the text of your queries and sample rows of data",
  },
];

export const AI_SYNC_OPTIONS: { value: AiSyncMode; label: string }[] = [
  { value: "automatic", label: "Automatically" },
  { value: "manual", label: "Manual" },
];

/** A Connection's AI Context at a glance: the latest build of its databases, stale when any is. */
export interface ContextAge {
  builtAt: number | null;
  stale: boolean;
  tables: number;
}

/** Sums one Connection's status rows; `tables` counts every database's tables. */
export function contextAge(rows: ContextStatusRow[], _now: number): ContextAge {
  let builtAt: number | null = null;
  let stale = false;
  let tables = 0;
  for (const r of rows) {
    if (builtAt === null || r.builtAt > builtAt) builtAt = r.builtAt;
    stale ||= r.stale;
    tables += r.tableCount;
  }
  return { builtAt, stale, tables };
}

/** "Synced 3m ago", "Synced just now", "Stale, synced 2d ago" or "Not built". */
export function contextText(age: ContextAge, now: number): string {
  if (age.builtAt === null) return "Not built";
  const ago = agoText(now - age.builtAt);
  const synced = ago === "now" ? "synced just now" : `synced ${ago}`;
  return age.stale ? `Stale, ${synced}` : `S${synced.slice(1)}`;
}

/** Why a Re-sync built nothing, or null when it built. Re-sync never opens a closed Connection. */
export function resyncProblem(info: ContextInfo, isOpen: boolean): string | null {
  if (info.check.kind !== "failed" && info.check.kind !== "missing") return null;
  if (!isOpen) return "Open the Connection to re-sync.";
  return info.check.kind === "failed" ? "Could not re-sync. The AI context from before is kept." : "Could not build the AI context.";
}

/** "1 table", "1,042 tables". */
export function tablesText(n: number): string {
  return n === 1 ? "1 table" : `${n.toLocaleString("en-US")} tables`;
}
