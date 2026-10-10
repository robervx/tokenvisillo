import {
  Session, BIG_OUTPUT_TOKENS, BIG_PROMPT_CHARS, REBUILD_MIN_PROMPT, RESET_RATIO, estTokens, textSize, firstLine, trackRequest,
} from './types';

/** Parser state that does not belong in the public Session. */
export interface ClaudeState {
  /** API responses already counted: one response is written as several lines, and resumes copy lines. */
  seen: Set<string>;
  /** Responses the parent conversation already counted (older versions log subagent turns in both files). */
  parentSeen?: Set<string>;
  /** True for a file under <session>/subagents/: its lines are that agent's own context. */
  sub: boolean;
  customTitle: boolean;
  prevPrompt: number;
  justCompacted: boolean;
  sawBoundary: boolean;
  prevTs?: number;
  tools: Map<string, { name: string; what?: string }>;
}

/** The argument that best identifies a tool call: the file, command or pattern. */
function target(input: any): string | undefined {
  const v = input?.file_path ?? input?.command ?? input?.pattern ?? input?.path ?? input?.url ?? input?.query;
  return typeof v === 'string' && v.trim() ? firstLine(v, 70) : undefined;
}

export const newClaudeState = (sub = false): ClaudeState => ({
  seen: new Set(), sub, customTitle: false,
  prevPrompt: 0, justCompacted: false, sawBoundary: false, tools: new Map(),
});

/**
 * Feed one line of ~/.claude/projects/<project>/<session>.jsonl.
 * Fields used: type, timestamp, cwd, sessionId, isSidechain, isMeta, isCompactSummary,
 * subtype, message.{id,model,content,usage}.
 */
export function feedClaude(s: Session, st: ClaudeState, o: any): void {
  if (!o || typeof o !== 'object') return;
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (!Number.isNaN(ts)) {
    s.startedAt ??= ts;
    s.updatedAt = ts;
  }
  if (o.cwd && !s.cwd) s.cwd = o.cwd;
  // A subagent file repeats its parent's sessionId, and marks every line as a sidechain.
  if (o.sessionId && !st.sub) s.id = o.sessionId;
  const side = Boolean(o.isSidechain) && !st.sub;

  // /rename wins over the generated title; both win over the first prompt.
  if ((o.type === 'custom-title' || o.type === 'ai-title') && !st.sub) {
    const title = o.customTitle ?? o.aiTitle ?? o.title;
    if (typeof title === 'string' && title.trim() && (o.type === 'custom-title' || !st.customTitle)) {
      s.title = firstLine(title);
      st.customTitle ||= o.type === 'custom-title';
    }
    return;
  }

  if (o.type === 'system' && (o.subtype === 'compact_boundary' || o.compactMetadata)) {
    s.compactions++;
    st.sawBoundary = true;
    st.justCompacted = true;
    return;
  }

  const msg = o.message;
  if (!msg) return;

  if (o.type === 'user') {
    if (o.isCompactSummary) {
      // Older logs have no compact_boundary line; count the summary instead.
      if (!st.sawBoundary) s.compactions++;
      st.sawBoundary = false;
      st.justCompacted = true;
      return;
    }
    const content = msg.content;
    let promptChars = 0;
    let promptText = '';
    if (typeof content === 'string') {
      promptChars = content.length;
      promptText = content;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_result') {
          const tokens = estTokens(textSize(b.content));
          if (tokens >= BIG_OUTPUT_TOKENS && !side) {
            const t = st.tools.get(b.tool_use_id);
            s.bigOutputs.push({ name: t?.name ?? 'tool', tokens, what: t?.what });
          }
        } else if (b?.type === 'text' && typeof b.text === 'string') {
          promptChars += b.text.length;
          promptText ||= b.text;
        }
      }
    }
    if (promptChars > 0 && !o.isMeta && !side && !promptText.startsWith('<')) {
      s.turns++;
      if (!st.sub) s.title ??= firstLine(promptText);
      if (promptChars >= BIG_PROMPT_CHARS) s.bigPrompts++;
    }
    return;
  }

  if (o.type !== 'assistant') return;

  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b?.type !== 'tool_use') continue;
      s.toolCalls++;
      if (b.id) st.tools.set(b.id, { name: b.name ?? 'tool', what: target(b.input) });
      const p = b.name === 'Read' ? b.input?.file_path : undefined;
      if (typeof p === 'string' && !side) s.repeats[p] = (s.repeats[p] ?? 0) + 1;
    }
  }

  const u = msg.usage;
  // Locally generated messages ("<synthetic>") are not API responses.
  if (!u || (typeof msg.model === 'string' && msg.model.startsWith('<'))) return;
  const key = msg.id ?? o.requestId ?? o.uuid;
  if (key) {
    if (st.seen.has(key) || st.parentSeen?.has(key)) return;
    st.seen.add(key);
  }

  const fresh = u.input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  // Cache writes come as one number or split by lifetime.
  const write = u.cache_creation_input_tokens
    ?? Object.values(u.cache_creation ?? {}).reduce((n: number, v) => n + (typeof v === 'number' ? v : 0), 0);
  const out = u.output_tokens ?? 0;
  s.input += fresh;
  s.cacheRead += read;
  s.cacheWrite += write;
  s.output += out;
  s.requests++;

  // Subagent turns cost tokens but live in their own context window.
  if (side) return;

  if (msg.model) s.model = msg.model;
  const prompt = fresh + read + write;
  if (s.baselineTokens === 0) s.baselineTokens = prompt;
  const rebuilt = !st.justCompacted && st.prevPrompt >= REBUILD_MIN_PROMPT
    && prompt >= st.prevPrompt * RESET_RATIO && read < st.prevPrompt * 0.5;
  trackRequest(s, prompt, read, rebuilt, st.prevTs && !Number.isNaN(ts) ? ts - st.prevTs : 0);
  if (!Number.isNaN(ts)) st.prevTs = ts;
  st.justCompacted = false;
  st.prevPrompt = prompt;
  s.contextTokens = prompt + out;
  s.peakContext = Math.max(s.peakContext, s.contextTokens);
}

/** Claude Code does not log the window size; infer it. */
export function claudeWindow(s: Session, override: number): void {
  if (override > 0) {
    s.contextWindow = override;
    s.windowKnown = true;
    return;
  }
  s.contextWindow = s.peakContext > 200_000 ? 1_000_000 : 200_000;
  s.windowKnown = false;
}
