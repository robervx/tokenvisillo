import { Advice } from './advisor';
import { Tool } from './types';

export type Lang = 'en' | 'es';

export function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

export const TOOL_NAME: Record<Tool, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Commands differ per tool; the advice text stays the same. */
const CMD: Record<Tool, { compact: string; fresh: string; inspect: string; memory: string }> = {
  claude: { compact: '/compact', fresh: '/clear', inspect: '/context', memory: 'CLAUDE.md' },
  codex: { compact: '/compact', fresh: '/new', inspect: '/status', memory: 'AGENTS.md' },
};

type Msg = (p: Advice['p'], tool: Tool) => string;

const ADVICE: Record<Lang, Record<Advice['id'], Msg>> = {
  en: {
    contextCritical: (p, t) => `Context is ${p.pct}% full. Ask for a short handoff summary and continue in a new conversation (${CMD[t].fresh}); every message now resends almost the whole window.`,
    contextHigh: (p, t) => `Context is ${p.pct}% full. Finish the current step, then run ${CMD[t].compact} or start a new conversation before quality drops.`,
    compactions: (p) => Number(p.n) > 1
      ? `Compacted ${p.n} times. Each compaction discards detail; split the work into one conversation per task.`
      : `Compacted once. If the next task is unrelated, a new conversation is cheaper than carrying the summary.`,
    lowCache: (p) => `Only ${p.pct}% of the prompt came from cache. Avoid switching model or tools mid-conversation and avoid long pauses, which force the full context to be re-read at full price.`,
    cacheRebuilds: (p) => `The cache was rebuilt ${p.n} times (large prompt sent with little reuse). Usually caused by long pauses or changing model/settings mid-conversation.`,
    bigOutputs: (p) => `${p.n} tool result(s) over 10k tokens (largest: ${p.name}, ~${fmt(Number(p.tokens))}). Ask for filtered output: search instead of dumping, read line ranges, limit log lines.`,
    repeats: (p) => `"${p.what}" was read/run ${p.n} times. Each repeat adds the same content to the context again.`,
    heavyBaseline: (p, t) => `The conversation starts at ~${fmt(Number(p.tokens))} tokens (${p.pct}% of the window) before your first message. Trim ${CMD[t].memory}, disable unused MCP servers and tools (check with ${CMD[t].inspect}).`,
    longSession: (p) => `${p.n} prompts in one conversation. Long mixed threads keep paying for old, unrelated context.`,
    bigPrompts: (p) => `${p.n} prompt(s) with large pasted text. Point to the file path instead so only the needed parts are read.`,
  },
  es: {
    contextCritical: (p, t) => `Contexto al ${p.pct}%. Pide un resumen de traspaso y continúa en una conversación nueva (${CMD[t].fresh}); ahora cada mensaje reenvía casi toda la ventana.`,
    contextHigh: (p, t) => `Contexto al ${p.pct}%. Termina el paso actual y usa ${CMD[t].compact} o abre una conversación nueva antes de que baje la calidad.`,
    compactions: (p) => Number(p.n) > 1
      ? `${p.n} compactaciones. Cada una pierde detalle; divide el trabajo en una conversación por tarea.`
      : `Una compactación. Si la siguiente tarea no tiene relación, sale más barato abrir una conversación nueva que arrastrar el resumen.`,
    lowCache: (p) => `Solo el ${p.pct}% del prompt salió de caché. Evita cambiar de modelo o de herramientas a mitad de conversación y las pausas largas: obligan a releer todo el contexto a precio completo.`,
    cacheRebuilds: (p) => `La caché se reconstruyó ${p.n} veces (prompt grande con poca reutilización). Suele deberse a pausas largas o a cambiar modelo/ajustes a mitad de conversación.`,
    bigOutputs: (p) => `${p.n} resultado(s) de herramienta de más de 10k tokens (el mayor: ${p.name}, ~${fmt(Number(p.tokens))}). Pide salidas filtradas: buscar en vez de volcar, leer rangos de líneas, limitar logs.`,
    repeats: (p) => `"${p.what}" se leyó/ejecutó ${p.n} veces. Cada repetición vuelve a meter el mismo contenido en el contexto.`,
    heavyBaseline: (p, t) => `La conversación arranca con ~${fmt(Number(p.tokens))} tokens (${p.pct}% de la ventana) antes de tu primer mensaje. Recorta ${CMD[t].memory} y desactiva servidores MCP y herramientas que no uses (míralo con ${CMD[t].inspect}).`,
    longSession: (p) => `${p.n} prompts en una misma conversación. Los hilos largos y mezclados siguen pagando contexto antiguo que ya no hace falta.`,
    bigPrompts: (p) => `${p.n} prompt(s) con mucho texto pegado. Indica la ruta del archivo para que solo se lea lo necesario.`,
  },
};

export const UI: Record<Lang, Record<string, string>> = {
  en: {
    context: 'Context', cache: 'Cache reuse', score: 'Efficiency', turns: 'Prompts', compactions: 'Compactions',
    spent: 'Tokens used', input: 'input', cached: 'cached', output: 'output', tips: 'Advice',
    noTips: 'Nothing to improve in this conversation.', estimated: 'window size estimated',
    empty: 'No recent Claude Code or Codex conversations found.',
    emptyScope: 'No recent conversations in this workspace. Use the filter button to show all.',
    scopeAll: 'All conversations', scopeWs: 'This workspace', untitled: '(untitled)',
    critical: 'context is {pct}% full. Consider a new conversation.', open: 'Open panel',
    idle: 'no active conversation',
  },
  es: {
    context: 'Contexto', cache: 'Uso de caché', score: 'Eficiencia', turns: 'Prompts', compactions: 'Compactaciones',
    spent: 'Tokens usados', input: 'entrada', cached: 'caché', output: 'salida', tips: 'Consejos',
    noTips: 'Nada que mejorar en esta conversación.', estimated: 'tamaño de ventana estimado',
    empty: 'No hay conversaciones recientes de Claude Code ni de Codex.',
    emptyScope: 'No hay conversaciones recientes en este espacio de trabajo. Usa el botón de filtro para verlas todas.',
    scopeAll: 'Todas las conversaciones', scopeWs: 'Este espacio de trabajo', untitled: '(sin título)',
    critical: 'contexto al {pct}%. Conviene abrir una conversación nueva.', open: 'Abrir panel',
    idle: 'sin conversación activa',
  },
};

export function adviceText(a: Advice, tool: Tool, lang: Lang): string {
  return ADVICE[lang][a.id](a.p, tool);
}

export function pickLang(setting: string, envLang: string): Lang {
  if (setting === 'en' || setting === 'es') return setting;
  return envLang.toLowerCase().startsWith('es') ? 'es' : 'en';
}
