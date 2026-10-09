export type Tool = 'claude' | 'codex';

/** One conversation, in a shape common to both tools. */
export interface Session {
  tool: Tool;
  id: string;
  file: string;
  cwd?: string;
  model?: string;
  title?: string;
  startedAt?: number;
  updatedAt?: number;

  /** Tokens occupying the context window after the latest request. */
  contextTokens: number;
  peakContext: number;
  contextWindow: number;
  /** false when the window size is a default guess rather than a logged value. */
  windowKnown: boolean;
  /** Prompt size of the very first request: system prompt, tools, MCP, memory files. */
  baselineTokens: number;

  /** Cumulative usage. `input` excludes cached tokens. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;

  requests: number;
  turns: number;
  compactions: number;
  /** Requests where a large prompt was sent with little or no cache reuse. */
  cacheRebuilds: number;
  toolCalls: number;
  /** `what` is the command or file that produced the output, when known. */
  bigOutputs: { name: string; tokens: number; what?: string }[];
  /** One entry per cache rebuild: minutes idle before it and tokens re-read at full price. */
  rebuilds: { gapMin: number; tokens: number }[];
  /** Prompt size of the latest requests, oldest first, to estimate how fast the context grows. */
  recentPrompts: number[];
  /** file path (Claude) or shell command (Codex) -> times read/run. */
  repeats: Record<string, number>;
  bigPrompts: number;

  /** Set when this conversation is a subagent spawned by another one. */
  parentId?: string;
  agent?: string;
  /** A subagent the tool starts by itself (Codex's automatic reviewer), not one the user's agent spawned. */
  auto?: boolean;
  /** Account usage limits as last reported in the log (Codex only). */
  limits?: { minutes: number; usedPercent: number }[];
  /** Filled by the monitor: subagent conversations spawned from this one. */
  children?: Session[];
  /** Latest activity in this conversation or any of its subagents. */
  activeAt?: number;
}

export const spent = (s: Session) => s.input + s.cacheRead + s.cacheWrite + s.output;

export function newSession(tool: Tool, file: string, id: string): Session {
  return {
    tool, id, file,
    contextTokens: 0, peakContext: 0, contextWindow: 0, windowKnown: false, baselineTokens: 0,
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
    requests: 0, turns: 0, compactions: 0, cacheRebuilds: 0, toolCalls: 0,
    bigOutputs: [], rebuilds: [], recentPrompts: [], repeats: {}, bigPrompts: 0,
  };
}

/** Thresholds shared by both parsers. */
export const BIG_OUTPUT_TOKENS = 10_000;
export const BIG_PROMPT_CHARS = 8_000;
export const REBUILD_MIN_PROMPT = 20_000;
/** A prompt this much smaller than the previous one means the context was reset, not that the cache missed. */
export const RESET_RATIO = 0.6;

/** Record one request's prompt size and, when the cache missed, what the miss cost. */
export function trackRequest(s: Session, prompt: number, cached: number, rebuilt: boolean, gapMs: number): void {
  if (rebuilt) {
    s.cacheRebuilds++;
    s.rebuilds.push({ gapMin: Math.max(0, Math.round(gapMs / 60000)), tokens: Math.max(0, prompt - cached) });
  }
  s.recentPrompts.push(prompt);
  if (s.recentPrompts.length > 12) s.recentPrompts.shift();
}

export const estTokens = (chars: number) => Math.round(chars / 4);

export function textSize(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return content.reduce((n: number, c) => n + textSize(c), 0);
  if (content && typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text.length;
    if (o.content !== undefined) return textSize(o.content);
    if (typeof o.output === 'string') return o.output.length;
  }
  return 0;
}

export function firstLine(s: string, max = 80): string {
  const line = s.trim().split(/\r?\n/)[0] ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
