import { Session } from './types';
import { analyze, Report, Thresholds } from './advisor';
import { adviceText, fmt, Lang, TOOL_NAME, UI } from './i18n';

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
}

export function toCard(s: Session, r: Report, lang: Lang): Card {
  const ui = UI[lang];
  return {
    tool: TOOL_NAME[s.tool],
    toolId: s.tool,
    title: s.title ?? ui.untitled,
    model: s.model ?? '',
    level: r.level,
    percent: Math.round(r.percent),
    contextLabel: `${fmt(s.contextTokens)} / ${fmt(s.contextWindow)}`,
    estimated: !s.windowKnown,
    grade: r.grade,
    score: r.score,
    stats: [
      { label: ui.cache, value: Math.round(r.cacheHit * 100) + '%' },
      { label: ui.turns, value: String(s.turns) },
      { label: ui.compactions, value: String(s.compactions) },
      {
        label: ui.spent,
        value: `${fmt(s.input + s.cacheWrite)} ${ui.input} · ${fmt(s.cacheRead)} ${ui.cached} · ${fmt(s.output)} ${ui.output}`,
      },
    ],
    tips: r.advice.map((a) => ({ severity: a.severity, text: adviceText(a, s.tool, lang) })),
  };
}

export function buildCards(sessions: Session[], t: Thresholds, lang: Lang): Card[] {
  return sessions.map((s) => toCard(s, analyze(s, t), lang));
}
