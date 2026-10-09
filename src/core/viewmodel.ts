import { Session, spent } from './types';
import { analyze, habits, Report, Thresholds } from './advisor';
import { adviceText, fmt, habitText, Lang, TOOL_NAME, UI } from './i18n';

/** Everything the panel shows for one conversation, already localized. */
export interface Card {
  tool: string;
  toolId: string;
  title: string;
  model: string;
  level: string;
  percent: number;
  contextLabel: string;
  estimated: boolean;
  grade: string;
  score: number;
  stats: { label: string; value: string }[];
  tips: { severity: string; text: string }[];
  childrenLabel: string;
  children: { name: string; level: string; percent: number; tokens: string }[];
}

export function toCard(s: Session, r: Report, t: Thresholds, lang: Lang): Card {
  const ui = UI[lang];
  const kids = s.children ?? [];
  const stats = [
    { label: ui.cache, value: Math.round(r.cacheHit * 100) + '%' },
    { label: ui.turns, value: String(s.turns) },
    { label: ui.compactions, value: String(s.compactions) },
    {
      label: ui.spent,
      value: `${fmt(s.input + s.cacheWrite)} ${ui.input} · ${fmt(s.cacheRead)} ${ui.cached} · ${fmt(s.output)} ${ui.output}`,
    },
  ];
  for (const l of s.limits ?? []) {
    const label = l.minutes === 300 ? ui.limit5h : l.minutes === 10080 ? ui.limitWeek : ui.limit;
    stats.push({ label, value: `${Math.round(l.usedPercent)}% ${ui.used}` });
  }
  const title = s.parentId ? `${s.agent ?? ui.subagent}` : s.title ?? ui.untitled;
  return {
    tool: TOOL_NAME[s.tool] + (s.parentId ? ` · ${ui.subagent}` : ''),
    toolId: s.tool,
    title,
    model: s.model ?? '',
    level: r.level,
    percent: Math.round(r.percent),
    contextLabel: `${fmt(s.contextTokens)} / ${fmt(s.contextWindow)}`,
    estimated: !s.windowKnown,
    grade: r.grade,
    score: r.score,
    stats,
    tips: r.advice.map((a) => ({ severity: a.severity, text: adviceText(a, s.tool, lang) })),
    childrenLabel: kids.length
      ? `${ui.subagents}: ${kids.length} · ${fmt(kids.reduce((n, k) => n + spent(k), 0))} ${ui.tokens}`
      : '',
    children: kids.map((k) => {
      const kr = analyze(k, t);
      return { name: k.agent ?? k.title ?? ui.subagent, level: kr.level, percent: Math.round(kr.percent), tokens: fmt(spent(k)) };
    }),
  };
}

export function buildCards(sessions: Session[], t: Thresholds, lang: Lang): Card[] {
  return sessions.map((s) => toCard(s, analyze(s, t), t, lang));
}

/** Recurring patterns across the listed conversations, already localized. */
export function buildHabits(sessions: Session[], t: Thresholds, lang: Lang): string[] {
  return habits(sessions, t).map((h) => habitText(h, lang));
}
