import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { defaultClaudeDir, defaultCodexDir } from './monitor';

// Values of these keys describe the log format, not the conversation.
const KEEP = new Set([
  'type', 'subtype', 'role', 'model', 'timestamp', 'stop_reason', 'phase', 'status', 'version', 'cli_version',
  'originator', 'thread_source', 'history_mode', 'userType', 'level', 'service_tier', 'plan_type', 'kind',
]);
// Tool names are kept only where they name a tool call.
const TOOL_ITEM = new Set(['tool_use', 'function_call', 'custom_tool_call', 'local_shell_call']);
// Identifiers become a short hash so links between lines survive.
const ID = /(^|_)(id|uuid)$|Id$|Uuid$/;
const hash = (v: string) => 'id_' + crypto.createHash('sha1').update(v).digest('hex').slice(0, 8);

/** Replace every piece of text with "[str:LENGTH]"; keep structure, numbers and tool names. */
export function scrub(v: unknown, key?: string, parent?: Record<string, unknown>): unknown {
  if (typeof v === 'string') {
    if (key && KEEP.has(key)) return v;
    if (key === 'name' && parent && TOOL_ITEM.has(parent.type as string)) return v;
    if (key && ID.test(key)) return hash(v);
    return `[str:${v.length}]`;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, key, parent));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x, k, v as Record<string, unknown>);
    return out;
  }
  return v;
}

export function scrubLog(text: string): string {
  return text.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.stringify(scrub(JSON.parse(l))); } catch { return JSON.stringify({ unparsable: l.length }); }
  }).join('\n') + '\n';
}

function newest(dir: string, depth: number, match: (name: string) => boolean, count: number): string[] {
  const found: { full: string; m: number }[] = [];
  const walk = (d: string, n: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && n < depth) walk(full, n + 1);
      else if (e.isFile() && match(e.name)) found.push({ full, m: fs.statSync(full).mtimeMs });
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => b.m - a.m).slice(0, count).map((f) => f.full);
}

/** File and folder names next to a Claude Code session, with identifiers masked. */
function layout(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = path.join(rel, e.name.replace(/[0-9a-f]{6,}/gi, 'ID'));
      out.push(r + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Write anonymized copies of the newest session logs of each tool into outDir.
 * Returns the files written. Nothing leaves the machine.
 */
export function exportAnonymized(outDir: string, opts: { claudeDir?: string; codexDir?: string; perTool?: number } = {}): string[] {
  const per = opts.perTool ?? 3;
  const written: string[] = [];
  const put = (name: string, content: string) => {
    fs.mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, name);
    fs.writeFileSync(target, content);
    written.push(target);
  };
  const claude = newest(path.join(opts.claudeDir || defaultClaudeDir(), 'projects'), 1, (n) => n.endsWith('.jsonl'), per);
  claude.forEach((file, i) => {
    put(`claude-${i + 1}.jsonl`, scrubLog(fs.readFileSync(file, 'utf8')));
    // Subagent logs live in a folder named after the session: keep the layout and one sample.
    const side = file.replace(/\.jsonl$/, '');
    if (!fs.existsSync(side)) return;
    put(`claude-${i + 1}-layout.txt`, layout(side).join('\n') + '\n');
    const sub = newest(side, 3, (n) => n.endsWith('.jsonl'), 1)[0];
    if (sub) put(`claude-${i + 1}-subagent.jsonl`, scrubLog(fs.readFileSync(sub, 'utf8')));
  });
  const codex = newest(path.join(opts.codexDir || defaultCodexDir(), 'sessions'), 3,
    (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), per);
  codex.forEach((file, i) => put(`codex-${i + 1}.jsonl`, scrubLog(fs.readFileSync(file, 'utf8'))));
  return written;
}
