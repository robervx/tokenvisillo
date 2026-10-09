#!/usr/bin/env node
/*
 * Makes a copy of a Claude Code or Codex session log with every piece of text removed,
 * so it can be attached to a bug report. Structure, numbers and tool names are kept;
 * prompts, answers, file contents, paths and commands are replaced by "[str:LENGTH]".
 *
 *   node tools/anonymize-log.js                 newest session of each tool
 *   node tools/anonymize-log.js path/to.jsonl   one specific log
 *
 * Output goes to ./tokenvisillo-anon/. Nothing is sent anywhere.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Values of these keys describe the format, not the conversation.
const KEEP = new Set([
  'type', 'subtype', 'role', 'model', 'timestamp', 'stop_reason', 'phase', 'status', 'version', 'cli_version',
  'originator', 'thread_source', 'history_mode', 'userType', 'level', 'service_tier', 'plan_type', 'kind',
]);
// Tool names are kept only where they name a tool call.
const TOOL_ITEM = new Set(['tool_use', 'function_call', 'custom_tool_call', 'local_shell_call']);
// Identifiers are replaced by a short hash so links between lines survive.
const ID = /(^|_)(id|uuid)$|Id$|Uuid$|^(session_id|thread_id|parent_thread_id|forked_from_id|call_id|turn_id|tool_use_id)$/;
const hash = (v) => 'id_' + crypto.createHash('sha1').update(v).digest('hex').slice(0, 8);

function scrub(v, key, parent) {
  if (typeof v === 'string') {
    if (KEEP.has(key)) return v;
    if (key === 'name' && parent && TOOL_ITEM.has(parent.type)) return v;
    if (ID.test(key || '')) return hash(v);
    return `[str:${v.length}]`;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, key, parent));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x, k, v);
    return out;
  }
  return v;
}

function newest(dir, depth, match) {
  let best;
  const walk = (d, n) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && n < depth) walk(full, n + 1);
      else if (e.isFile() && match(e.name)) {
        const m = fs.statSync(full).mtimeMs;
        if (!best || m > best.m) best = { full, m };
      }
    }
  };
  walk(dir, 0);
  return best && best.full;
}

function convert(file, label, outDir) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const out = lines.map((l) => {
    try { return JSON.stringify(scrub(JSON.parse(l))); } catch { return JSON.stringify({ unparsable: l.length }); }
  });
  const target = path.join(outDir, `${label}.jsonl`);
  fs.writeFileSync(target, out.join('\n') + '\n');
  console.log(`${label}: ${lines.length} lines -> ${target}`);
}

const outDir = path.resolve('tokenvisillo-anon');
fs.mkdirSync(outDir, { recursive: true });
const arg = process.argv[2];
if (arg) {
  convert(arg, 'session', outDir);
} else {
  const claudeDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const codexDir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const claude = newest(claudeDir, 1, (n) => n.endsWith('.jsonl'));
  const codex = newest(codexDir, 3, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
  if (claude) {
    convert(claude, 'claude', outDir);
    // Subagent logs live in a folder named after the session; keep the layout and one sample.
    const side = claude.replace(/\.jsonl$/, '');
    if (fs.existsSync(side)) {
      const layout = [];
      const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const r = path.join(rel, e.isDirectory() ? e.name : e.name.replace(/[0-9a-f]{6,}/gi, 'ID'));
          layout.push(r + (e.isDirectory() ? '/' : ''));
          if (e.isDirectory()) walk(path.join(d, e.name), r);
        }
      };
      walk(side, '');
      fs.writeFileSync(path.join(outDir, 'claude-layout.txt'), layout.join('\n') + '\n');
      const sub = newest(side, 3, (n) => n.endsWith('.jsonl'));
      if (sub) convert(sub, 'claude-subagent', outDir);
    }
  } else console.log('No Claude Code sessions found in ' + claudeDir);
  if (codex) convert(codex, 'codex', outDir);
  else console.log('No Codex sessions found in ' + codexDir);
}
