import { Session, Tool, spent, firstLine } from './types';

export type Severity = 'info' | 'warn' | 'crit';
export type Level = 'green' | 'yellow' | 'red';
export type AdviceId =
  | 'contextCritical' | 'contextHigh' | 'compactions' | 'lowCache' | 'cacheRebuilds'
  | 'bigOutputs' | 'repeats' | 'heavyBaseline' | 'longSession' | 'bigPrompts' | 'subagents';

export interface Advice {
  id: AdviceId;
  severity: Severity;
  /** Evidence from this conversation, interpolated into the localized message. */
  p: Record<string, string | number>;
}

export interface Thresholds {
  warnPercent: number;
  criticalPercent: number;
}

export interface Report {
  percent: number;
  level: Level;
  cacheHit: number;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E';
  advice: Advice[];
}

const PENALTY: Record<Severity, number> = { crit: 25, warn: 12, info: 5 };
const ORDER: Record<Severity, number> = { crit: 0, warn: 1, info: 2 };
/** A pause shorter than this does not explain a cache miss. */
export const SHORT_GAP_MIN = 5;

/** Shell commands that only show content already on disk. */
const READ_COMMAND = /^\s*(cat|sed|head|tail|less|more|nl|bat|rg|grep|ls|find|tree|wc|git\s+(diff|show|log|status|grep))\b/;

export function cacheHit(s: Session): number {
  const prompt = s.input + s.cacheRead + s.cacheWrite;
  return prompt > 0 ? s.cacheRead / prompt : 0;
}

/** Average growth of the prompt per request over the latest requests, ignoring resets. */
export function growthPerRequest(s: Session): number {
  const ups: number[] = [];
  for (let i = 1; i < s.recentPrompts.length; i++) {
    const d = s.recentPrompts[i] - s.recentPrompts[i - 1];
    if (d > 0) ups.push(d);
  }
  return ups.length >= 3 ? ups.reduce((a, b) => a + b, 0) / ups.length : 0;
}

/** The same rules run on Claude Code and Codex sessions; only the wording differs. */
export function analyze(s: Session, t: Thresholds): Report {
  const percent = s.contextWindow > 0 ? Math.min(100, (s.contextTokens / s.contextWindow) * 100) : 0;
  const level: Level = percent >= t.criticalPercent ? 'red' : percent >= t.warnPercent ? 'yellow' : 'green';
  const hit = cacheHit(s);
  const advice: Advice[] = [];
  const add = (id: AdviceId, severity: Severity, p: Advice['p'] = {}) => advice.push({ id, severity, p });

  if (level !== 'green') {
    const growth = growthPerRequest(s);
    const left = growth > 0 ? Math.floor((s.contextWindow - s.contextTokens) / growth) : -1;
    add(level === 'red' ? 'contextCritical' : 'contextHigh', level === 'red' ? 'crit' : 'warn', {
      pct: Math.round(percent), growth: Math.round(growth), left,
    });
  }

  if (s.compactions >= 2) add('compactions', 'warn', { n: s.compactions });
  else if (s.compactions === 1) add('compactions', 'info', { n: 1 });

  if (s.requests >= 8 && hit < 0.5) add('lowCache', 'warn', { pct: Math.round(hit * 100) });
  if (s.rebuilds.length >= 2) {
    const worst = s.rebuilds.reduce((a, b) => (b.tokens > a.tokens ? b : a));
    add('cacheRebuilds', s.rebuilds.length >= 4 ? 'warn' : 'info', {
      n: s.rebuilds.length,
      tokens: s.rebuilds.reduce((n, r) => n + r.tokens, 0),
      gap: worst.gapMin,
      // How many of the misses came after a real pause: tells apart "idle too long" from "changed settings".
      idle: s.rebuilds.filter((r) => r.gapMin >= SHORT_GAP_MIN).length,
    });
  }

  if (s.bigOutputs.length > 0) {
    const worst = s.bigOutputs.reduce((a, b) => (b.tokens > a.tokens ? b : a));
    add('bigOutputs', s.bigOutputs.length >= 3 ? 'warn' : 'info', {
      n: s.bigOutputs.length, name: worst.name, tokens: worst.tokens, what: worst.what ?? '',
      total: s.bigOutputs.reduce((n, o) => n + o.tokens, 0),
    });
  }

  // Re-reading the same file is waste; re-running the same test or build is normal work,
  // and what matters there is how much output each run adds.
  const repeated = Object.entries(s.repeats).filter(([, n]) => n >= 3)
    .map(([what, n]) => ({ what, n, run: s.tool === 'codex' && !READ_COMMAND.test(what) }))
    .sort((a, b) => Number(a.run) - Number(b.run) || b.n - a.n);
  if (repeated.length > 0) {
    const r = repeated[0];
    add('repeats', !r.run && r.n >= 5 ? 'warn' : 'info', {
      what: firstLine(r.what, 70), n: r.n, others: repeated.length - 1, run: r.run ? 1 : 0,
    });
  }

  const basePct = s.contextWindow > 0 ? (s.baselineTokens / s.contextWindow) * 100 : 0;
  if (s.baselineTokens >= 30_000 || basePct >= 15) {
    add('heavyBaseline', basePct >= 25 ? 'warn' : 'info', { tokens: s.baselineTokens, pct: Math.round(basePct) });
  }

  // Prompts in a subagent conversation are written by the parent agent, not by the user.
  const own = !s.parentId;
  if (own && s.turns >= 30 && level !== 'green') add('longSession', 'info', { n: s.turns });
  if (own && s.bigPrompts >= 1) add('bigPrompts', s.bigPrompts >= 3 ? 'warn' : 'info', { n: s.bigPrompts });

  // Only subagents the user's agent chose to spawn; the tool's own reviewer is reported apart.
  const everyKid = s.children ?? [];
  const kids = everyKid.filter((k) => !k.auto);
  const autoTokens = everyKid.filter((k) => k.auto).reduce((n, k) => n + spent(k), 0);
  const kidTokens = kids.reduce((n, k) => n + spent(k), 0);
  const all = kidTokens + autoTokens + spent(s);
  if (kids.length >= 2 && all > 0 && kidTokens / all >= 0.1) {
    const top = kids.reduce((a, b) => (spent(b) > spent(a) ? b : a));
    const share = kidTokens / all;
    add('subagents', share >= 0.6 ? 'warn' : 'info', {
      n: kids.length, tokens: kidTokens, pct: Math.round(share * 100),
      top: top.agent ?? top.title ?? '', topTokens: spent(top),
      base: Math.round(kids.reduce((n, k) => n + k.baselineTokens, 0) / kids.length),
      auto: autoTokens,
    });
  }

  advice.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  // Notes that cost no points: a modest share of subagent work or a re-run test is information, not a mistake.
  const scored = advice.filter((a) => !(a.id === 'subagents' && Number(a.p.pct) < 30) && !(a.id === 'repeats' && a.p.run));
  const score = Math.max(0, 100 - scored.reduce((n, a) => n + PENALTY[a.severity], 0));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E';
  return { percent, level, cacheHit: hit, score, grade, advice };
}

export type HabitId = 'context' | Exclude<AdviceId, 'contextCritical' | 'contextHigh'>;

export interface Habit {
  id: HabitId;
  /** Conversations where it happened, out of `of`. */
  count: number;
  of: number;
  /** Set when every occurrence was in the same tool. */
  tool?: Tool;
  /** Tokens involved across those conversations, when the rule measures any. */
  tokens: number;
}

/** How much a pattern matters when choosing which three to show. */
const WEIGHT: Record<HabitId, number> = {
  context: 4, cacheRebuilds: 3, subagents: 2, bigOutputs: 2, lowCache: 2, compactions: 2,
  repeats: 1, heavyBaseline: 1, longSession: 1, bigPrompts: 1,
};

/**
 * What keeps happening across conversations, as opposed to what is wrong with one of them.
 * A habit is something seen in at least two conversations and at least a third of them.
 */
export function habits(sessions: Session[], t: Thresholds): Habit[] {
  const tops = sessions.filter((s) => !s.parentId);
  if (tops.length < 2) return [];
  const found = new Map<HabitId, { tools: Set<Tool>; count: number; tokens: number }>();
  const hit = (id: HabitId, tool: Tool, tokens = 0) => {
    const h = found.get(id) ?? { tools: new Set<Tool>(), count: 0, tokens: 0 };
    h.tools.add(tool);
    h.count++;
    h.tokens += tokens;
    found.set(id, h);
  };
  for (const s of tops) {
    // The peak counts, not the current value: a conversation compacted after overflowing still overflowed.
    if (s.contextWindow > 0 && (s.peakContext / s.contextWindow) * 100 >= t.criticalPercent) hit('context', s.tool);
    for (const a of analyze(s, t).advice) {
      if (a.id === 'contextCritical' || a.id === 'contextHigh') continue;
      if (a.id === 'subagents' && Number(a.p.pct) < 30) continue;
      if (a.id === 'repeats' && a.p.run) continue;
      const tokens = Number(a.p.total ?? a.p.tokens ?? 0);
      hit(a.id, s.tool, a.id === 'heavyBaseline' ? 0 : tokens);
    }
  }
  return [...found.entries()]
    .filter(([, h]) => h.count >= 2 && h.count / tops.length >= 1 / 3)
    .map(([id, h]) => ({
      id, count: h.count, of: tops.length, tokens: h.tokens,
      tool: h.tools.size === 1 ? [...h.tools][0] : undefined,
    }))
    .sort((a, b) => WEIGHT[b.id] * b.count - WEIGHT[a.id] * a.count || b.tokens - a.tokens)
    .slice(0, 3);
}
