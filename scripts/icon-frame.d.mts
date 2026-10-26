export interface FrameRule {
  pad: number;
  stroke?: string;
  ink?: "outline" | "mono";
}
export function rootTag(text: string): { start: number; end: number; attrs: [string, string][] } | null;
export function frameRoot(text: string, rule: FrameRule): { svg: string; inkAt: number | null } | { refused: string; head?: string };
