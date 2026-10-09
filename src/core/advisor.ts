import { Session, spent, firstLine } from './types';

export type Severity = 'info' | 'warn' | 'crit';
export type Level = 'green' | 'yellow' | 'red';

export interface Advice {
  id:
    | 'contextCritical' | 'contextHigh' | 'compactions' | 'lowCache' | 'cacheRebuilds'
    | 'bigOutputs' | 'repeats' | 'heavyBaseline' | 'longSession' | 'bigPrompts' | 'subagents';
  severity: Severity;
  /** Values interpolated into the localized message. */
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

export function cacheHit(s: Session): number {
  const prompt = s.input + s.cacheRead + s.cacheWrite;
  return prompt > 0 ? s.cacheRead / prompt : 0;
}

/** The same rules run on Claude Code and Codex sessions; only the wording differs. */
export function analyze(s: Session, t: Thresholds): Report {
  const percent = s.contextWindow > 0 ? Math.min(100, (s.contextTokens / s.contextWindow) * 100) : 0;
  const level: Level = percent >= t.criticalPercent ? 'red' : percent >= t.warnPercent ? 'yellow' : 'green';
  const hit = cacheHit(s);
  const advice: Advice[] = [];
  const add = (id: Advice['id'], severity: Severity, p: Advice['p'] = {}) => advice.push({ id, severity, p });

  if (level === 'red') add('contextCritical', 'crit', { pct: Math.round(percent) });
  else if (level === 'yellow') add('contextHigh', 'warn', { pct: Math.round(percent) });

  if (s.compactions >= 2) add('compactions', 'warn', { n: s.compactions });
  else if (s.compactions === 1) add('compactions', 'info', { n: 1 });

  if (s.requests >= 8 && hit < 0.5) add('lowCache', 'warn', { pct: Math.round(hit * 100) });
  if (s.cacheRebuilds >= 2) add('cacheRebuilds', s.cacheRebuilds >= 4 ? 'warn' : 'info', { n: s.cacheRebuilds });

  if (s.bigOutputs.length > 0) {
    const worst = s.bigOutputs.reduce((a, b) => (b.tokens > a.tokens ? b : a));
    add('bigOutputs', s.bigOutputs.length >= 3 ? 'warn' : 'info', {
      n: s.bigOutputs.length, name: worst.name, tokens: worst.tokens,
    });
  }

  const repeated = Object.entries(s.repeats).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  if (repeated.length > 0) {
    add('repeats', repeated[0][1] >= 5 ? 'warn' : 'info', { what: firstLine(repeated[0][0], 70), n: repeated[0][1] });
  }

  const basePct = s.contextWindow > 0 ? (s.baselineTokens / s.contextWindow) * 100 : 0;
  if (s.baselineTokens >= 30_000 || basePct >= 15) {
    add('heavyBaseline', basePct >= 25 ? 'warn' : 'info', { tokens: s.baselineTokens, pct: Math.round(basePct) });
  }

  // Prompts in a subagent conversation are written by the parent agent, not by the user.
  const own = !s.parentId;
  if (own && s.turns >= 30 && level !== 'green') add('longSession', 'info', { n: s.turns });
  if (own && s.bigPrompts >= 1) add('bigPrompts', s.bigPrompts >= 3 ? 'warn' : 'info', { n: s.bigPrompts });

  const kids = s.children ?? [];
  const kidTokens = kids.reduce((n, k) => n + spent(k), 0);
  const all = kidTokens + spent(s);
  if (kids.length >= 2 && all > 0 && kidTokens / all >= 0.3) {
    add('subagents', kidTokens / all >= 0.6 ? 'warn' : 'info', {
      n: kids.length, tokens: kidTokens, pct: Math.round((kidTokens / all) * 100),
    });
  }

  advice.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const score = Math.max(0, 100 - advice.reduce((n, a) => n + PENALTY[a.severity], 0));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E';
  return { percent, level, cacheHit: hit, score, grade, advice };
}
