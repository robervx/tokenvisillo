import {
  Session, BIG_OUTPUT_TOKENS, BIG_PROMPT_CHARS, REBUILD_MIN_PROMPT, estTokens, textSize, firstLine,
} from './types';

export interface CodexState {
  lastTotal: number;
  prevPrompt: number;
  justCompacted: boolean;
  compactCounted: boolean;
  toolNames: Map<string, string>;
}

export const newCodexState = (): CodexState => ({
  lastTotal: -1, prevPrompt: 0, justCompacted: false, compactCounted: false, toolNames: new Map(),
});

export const CODEX_FALLBACK_WINDOW = 272_000;

function compaction(s: Session, st: CodexState): void {
  // A compaction is logged both as a `compacted` item and a `context_compacted` event.
  if (!st.compactCounted) s.compactions++;
  st.compactCounted = true;
  st.justCompacted = true;
}

function shellCommand(args: unknown): string | undefined {
  let a: any = args;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return undefined; }
  }
  const c = a?.command ?? a?.cmd;
  if (Array.isArray(c)) return c.join(' ');
  return typeof c === 'string' ? c : undefined;
}

/**
 * Feed one line of ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 * Lines are {timestamp, type, payload}; types used: session_meta, turn_context,
 * event_msg (token_count, user_message, context_compacted), response_item, compacted.
 */
export function feedCodex(s: Session, st: CodexState, o: any): void {
  if (!o || typeof o !== 'object') return;
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (!Number.isNaN(ts)) {
    s.startedAt ??= ts;
    s.updatedAt = ts;
  }
  const p = o.payload ?? {};

  // Early Codex versions wrote the meta line without a `type` wrapper.
  if (o.type === 'session_meta' || (!o.type && o.id)) {
    const m = o.type ? p : o;
    if (m.id) s.id = m.id;
    if (m.cwd) s.cwd = m.cwd;
    return;
  }
  if (o.type === 'turn_context') {
    if (p.model) s.model = p.model;
    if (p.cwd && !s.cwd) s.cwd = p.cwd;
    return;
  }
  if (o.type === 'compacted') return compaction(s, st);

  if (o.type === 'event_msg') {
    if (p.type === 'context_compacted') return compaction(s, st);
    if (p.type === 'user_message') {
      const text = typeof p.message === 'string' ? p.message : '';
      if (!text) return;
      s.turns++;
      s.title ??= firstLine(text);
      if (text.length >= BIG_PROMPT_CHARS) s.bigPrompts++;
      return;
    }
    if (p.type !== 'token_count' || !p.info) return;
    const total = p.info.total_token_usage;
    const last = p.info.last_token_usage;
    if (p.info.model_context_window > 0) {
      s.contextWindow = p.info.model_context_window;
      s.windowKnown = true;
    }
    if (!total) return;
    // The first token_count of a turn repeats the previous totals: skip repeats.
    const sum = total.total_tokens ?? (total.input_tokens ?? 0) + (total.output_tokens ?? 0);
    if (sum === st.lastTotal) return;
    st.lastTotal = sum;
    st.compactCounted = false;

    // OpenAI convention: input_tokens already includes cached_input_tokens.
    const cached = total.cached_input_tokens ?? 0;
    s.input = Math.max(0, (total.input_tokens ?? 0) - cached);
    s.cacheRead = cached;
    s.output = total.output_tokens ?? 0;
    s.requests++;

    if (!last) return;
    const prompt = last.input_tokens ?? 0;
    const lastCached = last.cached_input_tokens ?? 0;
    if (s.baselineTokens === 0) s.baselineTokens = prompt;
    if (!st.justCompacted && st.prevPrompt >= REBUILD_MIN_PROMPT && lastCached < st.prevPrompt * 0.5) {
      s.cacheRebuilds++;
    }
    st.justCompacted = false;
    st.prevPrompt = prompt;
    s.contextTokens = prompt + (last.output_tokens ?? 0);
    s.peakContext = Math.max(s.peakContext, s.contextTokens);
    return;
  }

  if (o.type !== 'response_item') return;
  switch (p.type) {
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call': {
      s.toolCalls++;
      const name = p.name ?? p.type;
      if (p.call_id) st.toolNames.set(p.call_id, name);
      const cmd = shellCommand(p.arguments ?? p.action ?? p.input);
      if (cmd) {
        const key = firstLine(cmd, 120);
        s.repeats[key] = (s.repeats[key] ?? 0) + 1;
      }
      break;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const tokens = estTokens(textSize(p.output));
      if (tokens >= BIG_OUTPUT_TOKENS) {
        s.bigOutputs.push({ name: st.toolNames.get(p.call_id) ?? 'tool', tokens });
      }
      break;
    }
  }
}

export function codexWindow(s: Session, override: number): void {
  if (override > 0) {
    s.contextWindow = override;
    s.windowKnown = true;
  } else if (!s.contextWindow) {
    s.contextWindow = CODEX_FALLBACK_WINDOW;
    s.windowKnown = false;
  }
}
