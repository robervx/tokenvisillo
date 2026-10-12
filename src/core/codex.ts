import {
  Session, BIG_OUTPUT_TOKENS, BIG_PROMPT_CHARS, REBUILD_MIN_PROMPT, RESET_RATIO, estTokens, textSize, firstLine, trackRequest,
} from './types';

type Usage = Record<string, number | undefined>;

export interface CodexState {
  metaSeen: boolean;
  firstTs?: number;
  /** Forked subagent logs start with a replay of the parent's history. */
  forked: boolean;
  replayDone: boolean;
  /** Newer logs number their lines; lines before this ordinal are the replayed parent history. */
  ownFrom?: number;
  hasRecords: boolean;
  records: number;
  lastTotal: number;
  prevTotals?: Usage;
  acc: { input: number; cached: number; write: number; output: number };
  prevPrompt: number;
  justCompacted: boolean;
  compactCounted: boolean;
  eventTurns: number;
  eventTitle?: string;
  itemTurns: number;
  itemTitle?: string;
  prevTs?: number;
  tools: Map<string, { name: string; what?: string }>;
}

export const newCodexState = (): CodexState => ({
  metaSeen: false, forked: false, replayDone: false, hasRecords: false, records: 0, lastTotal: -1,
  acc: { input: 0, cached: 0, write: 0, output: 0 },
  prevPrompt: 0, justCompacted: false, compactCounted: false,
  eventTurns: 0, itemTurns: 0, tools: new Map(),
});

export const CODEX_FALLBACK_WINDOW = 258_400;
/** Replayed parent history is stamped with the fork time; own activity starts seconds later. */
const REPLAY_WINDOW_MS = 1500;
const IDE_CONTEXT = '# Context from my IDE';
/** "## My request for Codex:" in older versions, "## My request:" in newer ones. */
const IDE_REQUEST = /^## My request[^\n]*:[ \t]*$/m;

function compaction(s: Session, st: CodexState): void {
  // A marker before this conversation's first request is inherited history, not its own compaction.
  if (s.requests === 0) return;
  // A compaction may be logged both as an item and as an event.
  if (!st.compactCounted) s.compactions++;
  st.compactCounted = true;
  st.justCompacted = true;
}

/** The whole command is the key: two scripts that merely start alike are not a repeat. */
function commandKey(raw: unknown): string | undefined {
  let a: any = raw;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return a.trim() || undefined; }
  }
  const c = a?.command ?? a?.cmd;
  if (Array.isArray(c)) return c.join(' ');
  return typeof c === 'string' ? c : undefined;
}

/**
 * Recent Codex versions run commands through an `exec` tool whose input is a short script:
 * `tools.exec_command({ cmd: "rg -n foo" })`. The commands inside are what the user recognizes.
 */
const INNER_CMD = /\bcmd\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
export function innerCommands(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(INNER_CMD)) if (m[2].trim()) out.push(m[2]);
  return out;
}

const n = (v: number | undefined) => v ?? 0;

/** OpenAI convention: input_tokens already includes cached_input_tokens. */
function setTotals(s: Session, input: number, cached: number, write: number, output: number): void {
  s.input = Math.max(0, input - cached);
  s.cacheRead = cached;
  s.cacheWrite = write;
  s.output = output;
}

/** The typed prompt, without the editor context the VS Code extension wraps around it. */
function userText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  let text = content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('').trim();
  if (!text || text.startsWith('<')) return undefined; // injected context blocks
  if (text.startsWith(IDE_CONTEXT)) {
    const m = IDE_REQUEST.exec(text);
    if (!m) return undefined;
    text = text.slice(m.index + m[0].length).trim();
  }
  return text || undefined;
}

function meta(s: Session, st: CodexState, m: any): void {
  if (st.metaSeen) return; // later session_meta lines belong to the replayed parent
  st.metaSeen = true;
  if (m.id) s.id = m.id;
  if (m.cwd) s.cwd = m.cwd;
  const parent = m.parent_thread_id || m.forked_from_id;
  if (parent) s.parentId = parent;
  st.forked = Boolean(m.forked_from_id);
  if (st.forked && typeof m.subagent_history_start_ordinal === 'number') st.ownFrom = m.subagent_history_start_ordinal;
  const sub = m.source?.subagent;
  const spawn = sub?.thread_spawn;
  const name = typeof spawn?.agent_path === 'string' ? spawn.agent_path.split('/').pop() : sub?.other;
  const role = spawn?.agent_role ?? m.agent_role;
  if (sub?.other) s.auto = true;
  if (name || role) s.agent = [name, role && `(${role})`].filter(Boolean).join(' ');
}

/**
 * Feed one line of ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ({timestamp, type, payload}).
 * Checked against logs written by Codex 0.107 to 0.153.
 */
export function feedCodex(s: Session, st: CodexState, o: any): void {
  if (!o || typeof o !== 'object') return;
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (!Number.isNaN(ts)) {
    s.startedAt ??= ts;
    s.updatedAt = ts;
    st.firstTs ??= ts;
    // Without line numbers, the replay is recognized by its timestamps: it is all written at the fork instant.
    if (st.ownFrom === undefined && ts - st.firstTs > REPLAY_WINDOW_MS) st.replayDone = true;
  }
  const p = o.payload ?? {};

  // Early Codex versions wrote the meta line without a `type` wrapper.
  if (o.type === 'session_meta' || (!o.type && o.id)) return meta(s, st, o.type ? p : o);
  if (o.type === 'turn_context') {
    if (p.model) s.model = p.model;
    if (p.cwd && !s.cwd) s.cwd = p.cwd;
    return;
  }

  // Newer versions write the thread's own cumulative usage. It is the most reliable source:
  // it survives resumes and never includes a parent's replayed history.
  if (o.type === 'token_usage_record') {
    if (p.thread_id && p.thread_id !== s.id) return;
    const t = p.thread_token_usage;
    if (!t) return;
    st.replayDone = true;
    st.hasRecords = true;
    s.requests = ++st.records;
    setTotals(s, n(t.input_tokens), n(t.cached_input_tokens), n(t.cache_write_input_tokens), n(t.output_tokens));
    return;
  }

  if (st.ownFrom !== undefined && typeof o.ordinal === 'number' && o.ordinal >= st.ownFrom) st.replayDone = true;
  const replay = st.forked && !st.replayDone;

  if (o.type === 'event_msg' && p.type === 'token_count') {
    if (p.rate_limits) {
      const limits = [p.rate_limits.primary, p.rate_limits.secondary]
        .filter((l) => l && typeof l.used_percent === 'number' && l.window_minutes > 0)
        .map((l) => ({ minutes: l.window_minutes as number, usedPercent: l.used_percent as number }));
      if (limits.length) s.limits = limits;
    }
    const info = p.info;
    if (!info) return;
    if (info.model_context_window > 0) {
      s.contextWindow = info.model_context_window;
      s.windowKnown = true;
    }
    const total: Usage | undefined = info.total_token_usage;
    const last: Usage | undefined = info.last_token_usage;
    if (!total) return;
    if (replay) {
      st.prevTotals = total;
      st.lastTotal = n(total.total_tokens);
      return;
    }
    // The first token_count of a turn repeats the previous totals: skip repeats.
    if (n(total.total_tokens) === st.lastTotal) return;
    st.lastTotal = n(total.total_tokens);
    st.compactCounted = false;

    if (!st.hasRecords) {
      // Totals restart when a conversation is resumed, so add up the increments instead.
      const prev = st.prevTotals;
      const restarted = prev !== undefined && n(total.total_tokens) < n(prev.total_tokens);
      const inc = (k: string) => (restarted ? n(last?.[k]) : n(total[k]) - n(prev?.[k]));
      st.acc.input += inc('input_tokens');
      st.acc.cached += inc('cached_input_tokens');
      st.acc.write += inc('cache_write_input_tokens');
      st.acc.output += inc('output_tokens');
      setTotals(s, st.acc.input, st.acc.cached, st.acc.write, st.acc.output);
      s.requests++;
    }
    st.prevTotals = total;

    if (!last) return;
    const prompt = n(last.input_tokens);
    if (s.baselineTokens === 0) s.baselineTokens = prompt;
    const shrank = prompt < st.prevPrompt * RESET_RATIO;
    // No compaction marker seen but the prompt halved: the context was reset.
    if (!st.justCompacted && st.prevPrompt >= 2 * REBUILD_MIN_PROMPT && prompt < st.prevPrompt * 0.5) s.compactions++;
    const cached = n(last.cached_input_tokens);
    const rebuilt = !st.justCompacted && !shrank && st.prevPrompt >= REBUILD_MIN_PROMPT && cached < st.prevPrompt * 0.5;
    trackRequest(s, prompt, cached, rebuilt, st.prevTs && !Number.isNaN(ts) ? ts - st.prevTs : 0);
    if (!Number.isNaN(ts)) st.prevTs = ts;
    st.justCompacted = false;
    st.prevPrompt = prompt;
    s.contextTokens = prompt + n(last.output_tokens);
    s.peakContext = Math.max(s.peakContext, s.contextTokens);
    return;
  }

  if (replay) return;
  if (o.type === 'compacted') return compaction(s, st);
  if (o.type === 'response_item' && p.type === 'compaction') return compaction(s, st);

  if (o.type === 'event_msg') {
    if (p.type === 'context_compacted') return compaction(s, st);
    if (p.type === 'task_started' && p.model_context_window > 0 && !s.contextWindow) {
      s.contextWindow = p.model_context_window;
      s.windowKnown = true;
    } else if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) {
      st.eventTurns++;
      st.eventTitle ??= firstLine(p.message);
      s.turns = st.eventTurns;
      s.title = st.eventTitle;
    }
    return;
  }

  if (o.type !== 'response_item') return;
  switch (p.type) {
    case 'message': {
      // Some versions only log prompts as items, others also as user_message events.
      if (p.role !== 'user') break;
      const text = userText(p.content);
      if (!text) break;
      st.itemTurns++;
      st.itemTitle ??= firstLine(text);
      if (text.length >= BIG_PROMPT_CHARS) s.bigPrompts++;
      if (st.eventTurns === 0) {
        s.turns = st.itemTurns;
        s.title = st.itemTitle;
      }
      break;
    }
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call': {
      s.toolCalls++;
      const name = p.name ?? p.type;
      const key = commandKey(p.arguments ?? p.input ?? p.action);
      const inner = key ? innerCommands(key) : [];
      const keys = inner.length ? inner : key && !key.includes('\n') ? [key] : [];
      if (p.call_id) st.tools.set(p.call_id, { name, what: keys[0] ? firstLine(keys[0], 70) : undefined });
      if (/exec|shell/.test(name)) {
        for (const k of keys) if (k.length <= 2000) s.repeats[k] = (s.repeats[k] ?? 0) + 1;
      }
      break;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const tokens = estTokens(textSize(p.output));
      if (tokens >= BIG_OUTPUT_TOKENS) {
        const t = st.tools.get(p.call_id);
        s.bigOutputs.push({ name: t?.name ?? 'tool', tokens, what: t?.what });
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
