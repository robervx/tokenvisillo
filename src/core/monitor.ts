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

interface Tracked {
  session: Session;
  state: ClaudeState | CodexState;
  offset: number;
  rest: string;
  decoder: StringDecoder;
}

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
  }

  private async candidates(): Promise<{ tool: Tool; file: string; mtime: number; size: number }[]> {
    const found: { tool: Tool; file: string }[] = [];
    const projects = path.join(this.opts.claudeDir || defaultClaudeDir(), 'projects');
    for (const proj of await ls(projects)) {
      if (!proj.isDirectory()) continue;
      // Only top-level files: subagent transcripts live in nested folders.
      for (const f of await ls(path.join(projects, proj.name))) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          found.push({ tool: 'claude', file: path.join(projects, proj.name, f.name) });
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

    const cutoff = Date.now() - this.opts.maxAgeMs;
    const out: { tool: Tool; file: string; mtime: number; size: number }[] = [];
    for (const c of found) {
      try {
        const st = await fs.promises.stat(c.file);
        if (st.mtimeMs >= cutoff) out.push({ ...c, mtime: st.mtimeMs, size: st.size });
      } catch { /* file vanished */ }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, this.opts.maxSessions);
  }

  private async tail(t: Tracked, tool: Tool, file: string, size: number): Promise<void> {
    if (size < t.offset) {
      // File was rewritten: start over.
      const id = path.basename(file, '.jsonl');
      t.session = newSession(tool, file, id);
      t.state = tool === 'claude' ? newClaudeState() : newCodexState();
      t.offset = 0;
      t.rest = '';
      t.decoder = new StringDecoder('utf8');
    }
    if (size === t.offset) return;
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size - t.offset, 8 * 1024 * 1024));
      while (t.offset < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - t.offset), t.offset);
        if (bytesRead === 0) break;
        t.offset += bytesRead;
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

  /** Returns recent sessions, most recently updated first. */
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
          state: c.tool === 'claude' ? newClaudeState() : newCodexState(),
          offset: 0, rest: '', decoder: new StringDecoder('utf8'),
        };
        this.tracked.set(c.file, t);
      }
      try {
        await this.tail(t, c.tool, c.file, c.size);
      } catch { continue; }
      const s = t.session;
      if (s.requests === 0) continue;
      s.updatedAt ??= c.mtime;
      if (c.tool === 'claude') claudeWindow(s, this.opts.claudeContextWindow ?? 0);
      else codexWindow(s, this.opts.codexContextWindow ?? 0);
      sessions.push(s);
    }
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return sessions;
  }
}
