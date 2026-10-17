import type { AiAccess, AiProviderKind } from "../../api/types";

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
    models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
    keyHint: "sk-ant-…",
    console: "console.anthropic.com",
  },
  groq: {
    name: "Groq",
    sub: "Fast open models",
    badge: "Free tier",
    url: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b", "qwen/qwen3-32b"],
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
