import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { Session, Tool, newSession } from './types';
import { ClaudeState, newClaudeState, feedClaude, claudeWindow } from './claude';
import { CodexState, newCodexState, feedCodex, codexWindow } from './codex';

export interface MonitorOptions {
  claudeDir?: string;
  codexDir?: string;
  maxAgeMs: number;
  maxSessions: number;
  claudeContextWindow?: number;
  codexContextWindow?: number;
}

interface Candidate {
  tool: Tool;
  file: string;
  /** For a Claude Code subagent log: the main conversation's file. */
  parentFile?: string;
  mtime: number;
  size: number;
}

interface Tracked {
  session: Session;
  state: ClaudeState | CodexState;
  offset: number;
  rest: string;
  decoder: StringDecoder;
  /** The last bytes read, to notice a file rewritten in place rather than appended to. */
  tailSig?: Buffer;
}

const SIG_BYTES = 64;
const FULL_SCAN_MS = 30_000;

export const defaultClaudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const defaultCodexDir = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

async function ls(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Reads session logs incrementally: only bytes appended since the last refresh are parsed. */
export class Monitor {
  private tracked = new Map<string, Tracked>();

  constructor(private opts: MonitorOptions) {}

  setOptions(opts: MonitorOptions): void {
    this.opts = opts;
    this.lastFullScan = 0;
  }

  private known = new Map<string, Omit<Candidate, 'mtime' | 'size'>>();
  private recent: Omit<Candidate, 'mtime' | 'size'>[] = [];
  private lastFullScan = 0;

  /** Every session log on disk, without reading or stat-ing any of them. */
  private async list(): Promise<Omit<Candidate, 'mtime' | 'size'>[]> {
    const found: Omit<Candidate, 'mtime' | 'size'>[] = [];
    const projects = path.join(this.opts.claudeDir || defaultClaudeDir(), 'projects');
    for (const proj of await ls(projects)) {
      if (!proj.isDirectory()) continue;
      // <session>.jsonl is a conversation; <session>/subagents/<agent>.jsonl are its subagents.
      const entries = await ls(path.join(projects, proj.name));
      const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
      for (const f of entries) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const file = path.join(projects, proj.name, f.name);
        found.push({ tool: 'claude', file });
        if (!dirs.has(f.name.slice(0, -'.jsonl'.length))) continue;
        const subs = path.join(file.slice(0, -'.jsonl'.length), 'subagents');
        for (const a of await ls(subs)) {
          if (a.isFile() && a.name.endsWith('.jsonl')) {
            found.push({ tool: 'claude', file: path.join(subs, a.name), parentFile: file });
          }
        }
      }
    }
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const e of await ls(dir)) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
        else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
          found.push({ tool: 'codex', file: full });
        }
      }
    };
    await walk(path.join(this.opts.codexDir || defaultCodexDir(), 'sessions'), 0);
    return found;
  }

  /**
   * Recent logs, newest first. Every file is stat-ed only on a full scan (every 30 s, which also
   * catches an old conversation that was resumed); in between, only the recent ones and new files are.
   */
  private async candidates(): Promise<Candidate[]> {
    const all = await this.list();
    let found: Omit<Candidate, 'mtime' | 'size'>[];
    if (Date.now() - this.lastFullScan >= FULL_SCAN_MS) {
      this.lastFullScan = Date.now();
      this.known = new Map(all.map((c) => [c.file, c]));
      found = all;
    } else {
      const fresh = all.filter((c) => !this.known.has(c.file));
      for (const c of fresh) this.known.set(c.file, c);
      found = [...this.recent, ...fresh];
    }

    const cutoff = Date.now() - this.opts.maxAgeMs;
    const out: Candidate[] = [];
    for (const c of found) {
      try {
        const st = await fs.promises.stat(c.file);
        if (st.mtimeMs >= cutoff) out.push({ ...c, mtime: st.mtimeMs, size: st.size });
      } catch { /* file vanished */ }
    }
    // Subagent logs are files too, so read well past the number of conversations shown.
    out.sort((a, b) => b.mtime - a.mtime);
    const picked = out.slice(0, this.opts.maxSessions * 8);
    this.recent = picked.map(({ tool, file, parentFile }) => ({ tool, file, parentFile }));
    // A conversation is always read before its own subagents.
    picked.sort((a, b) => Number(Boolean(a.parentFile)) - Number(Boolean(b.parentFile)));
    return picked;
  }

  /** What the sidecar <agent>.meta.json says the subagent is. */
  private async agentName(file: string): Promise<string> {
    const fallback = path.basename(file, '.jsonl');
    try {
      const meta = JSON.parse(await fs.promises.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      const parts = [meta.agentType, meta.description].filter((v) => typeof v === 'string' && v.trim());
      return parts.length ? parts.join(': ') : fallback;
    } catch {
      return fallback;
    }
  }

  /** True when the bytes just before the read offset are still the ones read last time. */
  private async sameTail(t: Tracked, file: string): Promise<boolean> {
    if (!t.tailSig || t.offset === 0) return true;
    const fh = await fs.promises.open(file, 'r');
    try {
      const n = t.tailSig.length;
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, t.offset - n);
      return bytesRead === n && buf.equals(t.tailSig);
    } finally {
      await fh.close();
    }
  }

  private async tail(t: Tracked, tool: Tool, file: string, size: number): Promise<void> {
    if (size === t.offset) return;
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size - t.offset, 8 * 1024 * 1024));
      while (t.offset < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - t.offset), t.offset);
        if (bytesRead === 0) break;
        t.offset += bytesRead;
        t.tailSig = Buffer.from(buf.subarray(Math.max(0, bytesRead - SIG_BYTES), bytesRead));
        const lines = (t.rest + t.decoder.write(buf.subarray(0, bytesRead))).split('\n');
        t.rest = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj: unknown;
          try { obj = JSON.parse(line); } catch { continue; }
          if (tool === 'claude') feedClaude(t.session, t.state as ClaudeState, obj);
          else feedCodex(t.session, t.state as CodexState, obj);
        }
      }
    } finally {
      await fh.close();
    }
  }

  /** Returns recent conversations, most recently active first, with subagents nested under their parent. */
  async refresh(): Promise<Session[]> {
    const cands = await this.candidates();
    const keep = new Set(cands.map((c) => c.file));
    for (const file of this.tracked.keys()) if (!keep.has(file)) this.tracked.delete(file);

    const sessions: Session[] = [];
    for (const c of cands) {
      let t = this.tracked.get(c.file);
      if (!t) {
        t = {
          session: newSession(c.tool, c.file, path.basename(c.file, '.jsonl')),
          state: c.tool === 'claude' ? newClaudeState(Boolean(c.parentFile)) : newCodexState(),
          offset: 0, rest: '', decoder: new StringDecoder('utf8'),
        };
        this.tracked.set(c.file, t);
      }
      if (c.size < t.offset || (c.size > t.offset && !(await this.sameTail(t, c.file)))) {
        // The file was rewritten (Codex migrates old logs in place, sometimes making them larger): start over.
        t.session = newSession(c.tool, c.file, path.basename(c.file, '.jsonl'));
        t.state = c.tool === 'claude' ? newClaudeState(Boolean(c.parentFile)) : newCodexState();
        t.offset = 0;
        t.rest = '';
        t.decoder = new StringDecoder('utf8');
        t.tailSig = undefined;
      }
      try {
        if (c.parentFile) {
          const parent = this.tracked.get(c.parentFile);
          // Read after the parent, so turns it already counted are not counted twice.
          (t.state as ClaudeState).parentSeen = (parent?.state as ClaudeState | undefined)?.seen;
          t.session.parentId = parent?.session.id ?? path.basename(c.parentFile, '.jsonl');
          t.session.cwd ??= parent?.session.cwd;
          t.session.agent ??= await this.agentName(c.file);
        }
        await this.tail(t, c.tool, c.file, c.size);
      } catch { continue; }
      const s = t.session;
      if (s.requests === 0) continue;
      s.updatedAt ??= c.mtime;
      if (c.tool === 'claude') claudeWindow(s, this.opts.claudeContextWindow ?? 0);
      else codexWindow(s, this.opts.codexContextWindow ?? 0);
      sessions.push(s);
    }
    return group(sessions).slice(0, this.opts.maxSessions);
  }
}

/** Nest subagent conversations under the conversation that spawned them. */
export function group(sessions: Session[]): Session[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const s of sessions) {
    s.children = [];
    s.activeAt = s.updatedAt ?? 0;
  }
  const top: Session[] = [];
  for (const s of sessions) {
    const parent = s.parentId ? byId.get(s.parentId) : undefined;
    if (!parent || parent === s) {
      top.push(s);
      continue;
    }
    parent.children!.push(s);
    parent.activeAt = Math.max(parent.activeAt ?? 0, s.updatedAt ?? 0);
  }
  for (const s of top) s.children!.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  top.sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));
  return top;
}
