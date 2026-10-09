import { Advice, AdviceId, Habit, HabitId } from './advisor';
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
const N = (v: string | number | undefined) => Number(v ?? 0);

/** "21 h", "40 min": how long the conversation sat idle. */
function gap(min: number): string {
  if (min >= 90) return `${Math.round(min / 60)} h`;
  return `${Math.max(1, Math.round(min))} min`;
}

// Each message states what was measured in this conversation first, then what to do about it.
const ADVICE: Record<Lang, Record<AdviceId, Msg>> = {
  en: {
    contextCritical: (p, t) => `Context is ${p.pct}% full${N(p.left) >= 0 ? `: at the current pace (+${fmt(N(p.growth))} per request) about ${p.left} request(s) remain` : ''}. Ask for a short handoff summary and continue in a new conversation (${CMD[t].fresh}); every message now resends almost the whole window.`,
    contextHigh: (p, t) => `Context is ${p.pct}% full${N(p.left) >= 0 ? `, growing ~${fmt(N(p.growth))} per request (about ${p.left} requests until full)` : ''}. Finish the current step, then run ${CMD[t].compact} or start a new conversation before quality drops.`,
    compactions: (p) => N(p.n) > 1
      ? `Compacted ${p.n} times. Each compaction discards detail; split the work into one conversation per task.`
      : `Compacted once. If the next task is unrelated, a new conversation is cheaper than carrying the summary.`,
    lowCache: (p) => `Only ${p.pct}% of the prompt came from cache. Avoid switching model or tools mid-conversation and avoid long pauses, which force the full context to be re-read at full price.`,
    cacheRebuilds: (p) => `The cache was lost ${p.n} times: ~${fmt(N(p.tokens))} tokens re-read at full price. ` + (N(p.idle) === 0
      ? `None followed a pause, so the cause is a change mid-conversation: model, reasoning level, tools or MCP servers. Change those between conversations, not during one.`
      : N(p.idle) === N(p.n)
        ? `All followed a pause (the costliest after ${gap(N(p.gap))} idle). When you come back after a break, start a new conversation with a summary instead of resuming a large one.`
        : `${p.idle} followed a pause (the costliest after ${gap(N(p.gap))} idle); the rest came from changing model or settings mid-conversation.`),
    bigOutputs: (p) => `${p.n} tool result(s) over 10k tokens, ~${fmt(N(p.total))} in total. The largest was ${p.name}${p.what ? ` on "${p.what}"` : ''} (~${fmt(N(p.tokens))}). Ask for filtered output: search instead of dumping, read line ranges, limit log lines.`,
    repeats: (p) => N(p.run)
      ? `"${p.what}" was run ${p.n} times. Re-running tests or builds is normal; make sure the output is short (quiet mode, failures only), because every run adds all of it to the context.`
      : `"${p.what}" was read ${p.n} times${N(p.others) > 0 ? ` (and ${p.others} more repeated item(s))` : ''}. Each repeat adds the same content to the context again; say once what you need from it.`,
    heavyBaseline: (p, t) => `The conversation starts at ~${fmt(N(p.tokens))} tokens (${p.pct}% of the window) before your first message. Trim ${CMD[t].memory}, disable unused MCP servers and tools (check with ${CMD[t].inspect}).`,
    longSession: (p) => `${p.n} prompts in one conversation. Long mixed threads keep paying for old, unrelated context.`,
    bigPrompts: (p) => `${p.n} prompt(s) with large pasted text. Point to the file path instead so only the needed parts are read.`,
    subagents: (p) => `${p.n} subagents used ${fmt(N(p.tokens))} tokens, ${p.pct}% of this conversation's total. The costliest was ${p.top} (${fmt(N(p.topTokens))}); each one starts with ~${fmt(N(p.base))} of context before doing anything. Spawn them for independent work, and give several small tasks to one agent instead of one agent each.${N(p.auto) > 0 ? ` On top of that, the automatic reviewer used ${fmt(N(p.auto))}.` : ''}`,
  },
  es: {
    contextCritical: (p, t) => `Contexto al ${p.pct}%${N(p.left) >= 0 ? `: al ritmo actual (+${fmt(N(p.growth))} por petición) quedan unas ${p.left} peticiones` : ''}. Pide un resumen de traspaso y continúa en una conversación nueva (${CMD[t].fresh}); ahora cada mensaje reenvía casi toda la ventana.`,
    contextHigh: (p, t) => `Contexto al ${p.pct}%${N(p.left) >= 0 ? `, creciendo ~${fmt(N(p.growth))} por petición (unas ${p.left} peticiones hasta llenarse)` : ''}. Termina el paso actual y usa ${CMD[t].compact} o abre una conversación nueva antes de que baje la calidad.`,
    compactions: (p) => N(p.n) > 1
      ? `${p.n} compactaciones. Cada una pierde detalle; divide el trabajo en una conversación por tarea.`
      : `Una compactación. Si la siguiente tarea no tiene relación, sale más barato abrir una conversación nueva que arrastrar el resumen.`,
    lowCache: (p) => `Solo el ${p.pct}% del prompt salió de caché. Evita cambiar de modelo o de herramientas a mitad de conversación y las pausas largas: obligan a releer todo el contexto a precio completo.`,
    cacheRebuilds: (p) => `La caché se perdió ${p.n} veces: ~${fmt(N(p.tokens))} tokens releídos a precio completo. ` + (N(p.idle) === 0
      ? `Ninguna fue tras una pausa, así que la causa es un cambio a mitad de conversación: modelo, nivel de razonamiento, herramientas o servidores MCP. Cámbialos entre conversaciones, no durante una.`
      : N(p.idle) === N(p.n)
        ? `Todas fueron tras una pausa (la más cara, después de ${gap(N(p.gap))} sin actividad). Cuando vuelvas de un descanso, abre una conversación nueva con un resumen en vez de retomar una grande.`
        : `${p.idle} fueron tras una pausa (la más cara, después de ${gap(N(p.gap))} sin actividad); el resto, por cambiar modelo o ajustes a mitad de conversación.`),
    bigOutputs: (p) => `${p.n} resultado(s) de herramienta de más de 10k tokens, ~${fmt(N(p.total))} en total. El mayor fue ${p.name}${p.what ? ` sobre "${p.what}"` : ''} (~${fmt(N(p.tokens))}). Pide salidas filtradas: buscar en vez de volcar, leer rangos de líneas, limitar logs.`,
    repeats: (p) => N(p.run)
      ? `"${p.what}" se ejecutó ${p.n} veces. Repetir pruebas o compilaciones es normal; asegúrate de que la salida sea corta (modo silencioso, solo fallos), porque cada ejecución la añade entera al contexto.`
      : `"${p.what}" se leyó ${p.n} veces${N(p.others) > 0 ? ` (y hay ${p.others} elemento(s) repetido(s) más)` : ''}. Cada repetición vuelve a meter el mismo contenido en el contexto; di de una vez qué necesitas de ahí.`,
    heavyBaseline: (p, t) => `La conversación arranca con ~${fmt(N(p.tokens))} tokens (${p.pct}% de la ventana) antes de tu primer mensaje. Recorta ${CMD[t].memory} y desactiva servidores MCP y herramientas que no uses (míralo con ${CMD[t].inspect}).`,
    longSession: (p) => `${p.n} prompts en una misma conversación. Los hilos largos y mezclados siguen pagando contexto antiguo que ya no hace falta.`,
    bigPrompts: (p) => `${p.n} prompt(s) con mucho texto pegado. Indica la ruta del archivo para que solo se lea lo necesario.`,
    subagents: (p) => `${p.n} subagentes han gastado ${fmt(N(p.tokens))} tokens, el ${p.pct}% del total de esta conversación. El más caro fue ${p.top} (${fmt(N(p.topTokens))}); cada uno arranca con ~${fmt(N(p.base))} de contexto antes de hacer nada. Lánzalos para trabajo independiente y agrupa varias tareas pequeñas en un mismo agente en vez de uno por tarea.${N(p.auto) > 0 ? ` Aparte, el revisor automático gastó ${fmt(N(p.auto))}.` : ''}`,
  },
};

type HabitMsg = (h: Habit) => string;
const where = (h: Habit, lang: Lang) => (h.tool ? (lang === 'es' ? `, siempre en ${TOOL_NAME[h.tool]}` : `, always in ${TOOL_NAME[h.tool]}`) : '');

// A habit names the pattern across conversations and the one change that would break it.
const HABITS: Record<Lang, Record<HabitId, HabitMsg>> = {
  en: {
    context: (h) => `You let the context reach red in ${h.count} of your last ${h.of} conversations${where(h, 'en')}. Set yourself a cut-off: at yellow, close the step and hand over to a new conversation.`,
    compactions: (h) => `${h.count} of your last ${h.of} conversations were compacted${where(h, 'en')}. Your conversations run longer than one task; start a new one per task.`,
    lowCache: (h) => `Low cache reuse in ${h.count} of your last ${h.of} conversations${where(h, 'en')}. Keep model and tools fixed within a conversation.`,
    cacheRebuilds: (h) => `You lost the cache in ${h.count} of your last ${h.of} conversations${where(h, 'en')} (~${fmt(h.tokens)} tokens re-read). Resuming large conversations after a break is your most repeated cost.`,
    bigOutputs: (h) => `Huge tool results in ${h.count} of your last ${h.of} conversations${where(h, 'en')} (~${fmt(h.tokens)} tokens). Add a standing rule to ${h.tool === 'codex' ? 'AGENTS.md' : h.tool === 'claude' ? 'CLAUDE.md' : 'CLAUDE.md / AGENTS.md'}: never dump whole files or logs, always filter.`,
    repeats: (h) => `The same file or command is re-read several times in ${h.count} of your last ${h.of} conversations${where(h, 'en')}. Tell the agent which parts matter up front.`,
    heavyBaseline: (h) => `${h.count} of your last ${h.of} conversations start heavy${where(h, 'en')}. That fixed cost is paid in every conversation: trimming it once pays back every time.`,
    longSession: (h) => `${h.count} of your last ${h.of} conversations are very long${where(h, 'en')}. One conversation per task.`,
    bigPrompts: (h) => `You paste large text into prompts in ${h.count} of your last ${h.of} conversations${where(h, 'en')}. Reference files by path instead.`,
    subagents: (h) => `Subagents take a large share of the tokens in ${h.count} of your last ${h.of} conversations${where(h, 'en')} (~${fmt(h.tokens)}). Check whether each one needed to be a separate agent.`,
  },
  es: {
    context: (h) => `Dejas que el contexto llegue a rojo en ${h.count} de tus últimas ${h.of} conversaciones${where(h, 'es')}. Ponte un corte: en amarillo, cierra el paso y traspasa a una conversación nueva.`,
    compactions: (h) => `${h.count} de tus últimas ${h.of} conversaciones se compactaron${where(h, 'es')}. Tus conversaciones duran más que una tarea; abre una nueva por tarea.`,
    lowCache: (h) => `Poca reutilización de caché en ${h.count} de tus últimas ${h.of} conversaciones${where(h, 'es')}. Mantén fijos el modelo y las herramientas dentro de una conversación.`,
    cacheRebuilds: (h) => `Pierdes la caché en ${h.count} de tus últimas ${h.of} conversaciones${where(h, 'es')} (~${fmt(h.tokens)} tokens releídos). Retomar conversaciones grandes tras un descanso es tu coste más repetido.`,
    bigOutputs: (h) => `Resultados de herramienta enormes en ${h.count} de tus últimas ${h.of} conversaciones${where(h, 'es')} (~${fmt(h.tokens)} tokens). Añade una regla fija en ${h.tool === 'codex' ? 'AGENTS.md' : h.tool === 'claude' ? 'CLAUDE.md' : 'CLAUDE.md / AGENTS.md'}: nunca volcar archivos o logs enteros, siempre filtrar.`,
    repeats: (h) => `El mismo archivo o comando se relee varias veces en ${h.count} de tus últimas ${h.of} conversaciones${where(h, 'es')}. Dile al agente desde el principio qué partes importan.`,
    heavyBaseline: (h) => `${h.count} de tus últimas ${h.of} conversaciones arrancan pesadas${where(h, 'es')}. Ese coste fijo se paga en cada conversación: recortarlo una vez ahorra siempre.`,
    longSession: (h) => `${h.count} de tus últimas ${h.of} conversaciones son muy largas${where(h, 'es')}. Una conversación por tarea.`,
    bigPrompts: (h) => `Pegas mucho texto en los prompts en ${h.count} de tus últimas ${h.of} conversaciones${where(h, 'es')}. Indica la ruta del archivo.`,
    subagents: (h) => `Los subagentes se llevan buena parte de los tokens en ${h.count} de tus últimas ${h.of} conversaciones${where(h, 'es')} (~${fmt(h.tokens)}). Revisa si cada uno necesitaba ser un agente aparte.`,
  },
};

export const habitText = (h: Habit, lang: Lang) => HABITS[lang][h.id](h);

export const UI: Record<Lang, Record<string, string>> = {
  en: {
    context: 'Context', cache: 'Cache reuse', score: 'Efficiency', turns: 'Prompts', compactions: 'Compactions',
    spent: 'Tokens used', input: 'input', cached: 'cached', output: 'output', tips: 'Advice',
    noTips: 'Nothing to improve in this conversation.', estimated: 'window size estimated',
    empty: 'No recent Claude Code or Codex conversations found.',
    emptyScope: 'No recent conversations in this workspace. Use the filter button to show all.',
    scopeAll: 'All conversations', scopeWs: 'This workspace', untitled: '(untitled)',
    critical: 'context is {pct}% full. Consider a new conversation.', open: 'Open panel',
    idle: 'no active conversation', subagents: 'Subagents', subagent: 'subagent',
    limit5h: '5-hour limit', limitWeek: 'Weekly limit', limit: 'Usage limit', used: 'used', tokens: 'tokens',
    habits: 'Your patterns', exportPick: 'Save anonymized logs here',
    exportDone: 'Anonymized logs written to {dir} ({n} files). All text was replaced by placeholders.',
    exportNone: 'No session logs found to export.',
  },
  es: {
    context: 'Contexto', cache: 'Uso de caché', score: 'Eficiencia', turns: 'Prompts', compactions: 'Compactaciones',
    spent: 'Tokens usados', input: 'entrada', cached: 'caché', output: 'salida', tips: 'Consejos',
    noTips: 'Nada que mejorar en esta conversación.', estimated: 'tamaño de ventana estimado',
    empty: 'No hay conversaciones recientes de Claude Code ni de Codex.',
    emptyScope: 'No hay conversaciones recientes en este espacio de trabajo. Usa el botón de filtro para verlas todas.',
    scopeAll: 'Todas las conversaciones', scopeWs: 'Este espacio de trabajo', untitled: '(sin título)',
    critical: 'contexto al {pct}%. Conviene abrir una conversación nueva.', open: 'Abrir panel',
    idle: 'sin conversación activa', subagents: 'Subagentes', subagent: 'subagente',
    limit5h: 'Límite de 5 h', limitWeek: 'Límite semanal', limit: 'Límite de uso', used: 'usado', tokens: 'tokens',
    habits: 'Tus patrones', exportPick: 'Guardar aquí los registros anonimizados',
    exportDone: 'Registros anonimizados guardados en {dir} ({n} archivos). Todo el texto se ha sustituido por marcadores.',
    exportNone: 'No se han encontrado registros de sesión que exportar.',
  },
};

export function adviceText(a: Advice, tool: Tool, lang: Lang): string {
  return ADVICE[lang][a.id](a.p, tool);
}

export function pickLang(setting: string, envLang: string): Lang {
  if (setting === 'en' || setting === 'es') return setting;
  return envLang.toLowerCase().startsWith('es') ? 'es' : 'en';
}
