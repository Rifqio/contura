// The pack is a Node Buffer at run time; typed as Uint8Array because the app's tsconfig has no Node types.
export type SetId = "aws" | "azure" | "gcp" | "k8s" | "lucide" | "simple";

export interface SetReport {
  left?: string;
  bytes: number;
  packed: number;
  aliases: number;
  badName: string[];
  reserved: string[];
  duplicate: string[];
  unsafe: Record<string, string[]>;
  unframed: Record<string, string[]>;
  ownLicence: string[];
  noColour: string[];
  missedAliases: string[];
  renamed: string[];
  dropped: string[];
  warnings: string[];
}

export interface BuildOptions {
  brands?: readonly string[];
  maxBytes?: number;
  maxIndexBytes?: number;
  previous?: Uint8Array | null;
  renamed?: Record<string, string>;
  dropped?: Record<string, string>;
}

export const PAD: Record<SetId, number>;
export const STROKE: "1.5";
export const RESERVED: readonly string[];
export const RENAMED: Record<string, string>;
export const DROPPED: Record<string, string>;
export const CHANGES: Record<SetId, string>;

export function buildPack(
  src: string,
  opts?: BuildOptions,
): {
  pack: Uint8Array;
  report: Record<string, SetReport>;
  samples: Map<string, { drawingSha256: string; file: string }>;
  indexBytes: number;
};
export function readPackIndex(pack: Uint8Array): {
  version: 1 | 2;
  sets: object[];
  icons: unknown[][];
};
export function contactSheet(pack: Uint8Array, opts?: { limit?: number }): string;
export function brandInk(hex: string, theme: "light" | "dark"): { ink: string; outline: boolean };
