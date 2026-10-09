import {
  Session, BIG_OUTPUT_TOKENS, BIG_PROMPT_CHARS, REBUILD_MIN_PROMPT, estTokens, textSize, firstLine,
} from './types';

/** Parser state that does not belong in the public Session. */
export interface ClaudeState {
  lastMsgId?: string;
  prevPrompt: number;
  justCompacted: boolean;
  sawBoundary: boolean;
  toolNames: Map<string, string>;
}

export const newClaudeState = (): ClaudeState => ({
  prevPrompt: 0, justCompacted: false, sawBoundary: false, toolNames: new Map(),
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
  if (o.sessionId) s.id = o.sessionId;

  if (o.type === 'system' && o.subtype === 'compact_boundary') {
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
          if (tokens >= BIG_OUTPUT_TOKENS && !o.isSidechain) {
            s.bigOutputs.push({ name: st.toolNames.get(b.tool_use_id) ?? 'tool', tokens });
          }
        } else if (b?.type === 'text' && typeof b.text === 'string') {
          promptChars += b.text.length;
          promptText ||= b.text;
        }
      }
    }
    if (promptChars > 0 && !o.isMeta && !o.isSidechain && !promptText.startsWith('<')) {
      s.turns++;
      s.title ??= firstLine(promptText);
      if (promptChars >= BIG_PROMPT_CHARS) s.bigPrompts++;
    }
    return;
  }

  if (o.type !== 'assistant') return;

  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b?.type !== 'tool_use') continue;
      s.toolCalls++;
      if (b.id) st.toolNames.set(b.id, b.name ?? 'tool');
      const p = b.name === 'Read' ? b.input?.file_path : undefined;
      if (typeof p === 'string' && !o.isSidechain) s.repeats[p] = (s.repeats[p] ?? 0) + 1;
    }
  }

  const u = msg.usage;
  if (!u || msg.model === '<synthetic>') return;
  // One API response is written as several lines (one per content block) with the same usage.
  if (msg.id && msg.id === st.lastMsgId) return;
  st.lastMsgId = msg.id;

  const fresh = u.input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const out = u.output_tokens ?? 0;
  s.input += fresh;
  s.cacheRead += read;
  s.cacheWrite += write;
  s.output += out;
  s.requests++;

  // Subagent turns cost tokens but live in their own context window.
  if (o.isSidechain) return;

  if (msg.model) s.model = msg.model;
  const prompt = fresh + read + write;
  if (s.baselineTokens === 0) s.baselineTokens = prompt;
  if (!st.justCompacted && st.prevPrompt >= REBUILD_MIN_PROMPT && read < st.prevPrompt * 0.5) {
    s.cacheRebuilds++;
  }
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
