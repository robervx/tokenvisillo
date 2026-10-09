import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Monitor } from '../core/monitor';
import { analyze } from '../core/advisor';
import { buildCards } from '../core/viewmodel';

const T = { warnPercent: 60, criticalPercent: 85 };
const iso = (min: number) => new Date(Date.UTC(2026, 9, 10, 8, min)).toISOString();
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function claudeAssistant(id: string, min: number, usage: object, content: unknown[] = [{ type: 'text', text: 'ok' }]) {
  return {
    type: 'assistant', sessionId: 'c1', cwd: '/work/app', timestamp: iso(min),
    message: { id, role: 'assistant', model: 'claude-sonnet-5-5', content, usage },
  };
}
const claudeUser = (min: number, content: unknown, extra: object = {}) => ({
  type: 'user', sessionId: 'c1', cwd: '/work/app', timestamp: iso(min), message: { role: 'user', content }, ...extra,
});

function claudeFixture(): unknown[] {
  const big = 'x'.repeat(60_000); // ~15k tokens
  return [
    claudeUser(0, 'Refactor the auth module'),
    // Same API response split over two lines: usage must be counted once.
    claudeAssistant('m1', 1, { input_tokens: 2000, cache_creation_input_tokens: 38000, cache_read_input_tokens: 0, output_tokens: 500 },
      [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/app/auth.ts' } }]),
    claudeAssistant('m1', 1, { input_tokens: 2000, cache_creation_input_tokens: 38000, cache_read_input_tokens: 0, output_tokens: 500 },
      [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cat log' } }]),
    claudeUser(1, [{ type: 'tool_result', tool_use_id: 't1', content: 'small' }, { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: big }] }]),
    claudeAssistant('m2', 2, { input_tokens: 100, cache_creation_input_tokens: 16000, cache_read_input_tokens: 40000, output_tokens: 900 },
      [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/work/app/auth.ts' } }]),
    claudeUser(2, [{ type: 'tool_result', tool_use_id: 't3', content: 'small' }]),
    claudeAssistant('m3', 3, { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 56000, output_tokens: 300 },
      [{ type: 'tool_use', id: 't4', name: 'Read', input: { file_path: '/work/app/auth.ts' } }]),
    claudeUser(3, [{ type: 'tool_result', tool_use_id: 't4', content: 'small' }]),
    // Long pause: nothing read from cache.
    claudeUser(90, 'now add tests'),
    claudeAssistant('m4', 91, { input_tokens: 100, cache_creation_input_tokens: 58000, cache_read_input_tokens: 0, output_tokens: 400 }),
    // Subagent traffic counts toward spend, not toward this context window.
    { ...claudeAssistant('s1', 92, { input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 }), isSidechain: true },
    { type: 'system', subtype: 'compact_boundary', sessionId: 'c1', timestamp: iso(93) },
    claudeUser(93, 'Summary of the conversation so far', { isCompactSummary: true }),
    claudeAssistant('m5', 94, { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 130000, output_tokens: 4900 }),
  ];
}

type U = { input_tokens: number; cached_input_tokens: number; output_tokens: number; total_tokens: number };
const usage = (input: number, cached: number, output: number): U =>
  ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output });
function codexToken(min: number, total: U, last: U, extra: object = {}) {
  return { timestamp: iso(min), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 200000 }, rate_limits: null, ...extra } };
}
const codexItem = (min: number, payload: object) => ({ timestamp: iso(min), type: 'response_item', payload });
const codexUser = (min: number, text: string) => codexItem(min, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

function codexFixture(): unknown[] {
  const t1 = usage(30000, 0, 1000);
  const call = (id: string) => codexItem(2, { type: 'custom_tool_call', name: 'exec', call_id: id, input: 'cat src/big.json' });
  return [
    { timestamp: iso(0), type: 'session_meta', payload: { id: 'x1', cwd: '/work/api' } },
    { timestamp: iso(0), type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/work/api' } },
    codexUser(0, '<environment_context>\nignored\n</environment_context>'),
    codexUser(0, '# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n\n## My request:\nFix the failing endpoint\nmore detail'),
    codexToken(1, t1, t1),
    call('a'), call('b'), call('c'),
    codexItem(2, { type: 'custom_tool_call_output', call_id: 'c', output: 'y'.repeat(48_000) }),
    codexItem(2, { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: 'd', arguments: '{"task_name":"review"}' }),
    codexToken(3, t1, t1), // repeat of the previous totals
    codexToken(4, usage(210000, 5000, 3000), usage(180000, 5000, 2000), {
      rate_limits: { primary: { used_percent: 57, window_minutes: 10080 }, secondary: null },
    }),
    { timestamp: iso(5), type: 'compacted', payload: { message: 'summary' } },
    { timestamp: iso(5), type: 'event_msg', payload: { type: 'context_compacted' } },
  ];
}

/** A resumed conversation: the running total restarts, and no usage records are written (older Codex). */
function codexResumedFixture(): unknown[] {
  const a = usage(20000, 0, 500);
  return [
    { timestamp: iso(0), type: 'session_meta', payload: { id: 'x2', cwd: '/work/api' } },
    { timestamp: iso(0), type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
    codexUser(0, 'first'),
    codexToken(1, a, a),
    codexToken(2, usage(45000, 20000, 900), usage(25000, 20000, 400)),
    // resumed: total starts again from this request
    codexToken(50, usage(26000, 0, 300), usage(26000, 0, 300)),
    codexToken(51, usage(54000, 26000, 700), usage(28000, 26000, 400)),
  ];
}

/** A forked subagent: the parent's history is replayed at the fork instant, then its own work follows. */
function codexSubagentFixture(): unknown[] {
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 10, 8, 30, 0, ms)).toISOString();
  const tc = (ms: number, total: U, last: U) => ({ ...codexToken(0, total, last), timestamp: at(ms) });
  const rec = (ms: number, thread: U) => ({ timestamp: at(ms), type: 'token_usage_record', payload: { thread_id: 'sub1', usage: thread, thread_token_usage: thread } });
  return [
    { timestamp: at(0), type: 'session_meta', payload: { id: 'sub1', cwd: '/work/api', parent_thread_id: 'x1', forked_from_id: 'x1', source: { subagent: { thread_spawn: { parent_thread_id: 'x1', agent_path: '/root/review_lab', agent_role: 'senior_dev' } } } } },
    { timestamp: at(1), type: 'session_meta', payload: { id: 'x1', cwd: '/elsewhere' } },
    { ...codexUser(0, 'parent prompt'), timestamp: at(2) },
    tc(3, usage(30000, 0, 1000), usage(30000, 0, 1000)),
    tc(4, usage(2_000_000, 1_900_000, 9000), usage(120000, 118000, 800)),
    rec(7000, usage(18000, 0, 100)),
    tc(7001, usage(2_018_000, 1_900_000, 9100), usage(18000, 0, 100)),
    rec(12000, usage(40000, 17000, 400)),
    tc(12001, usage(2_040_000, 1_917_000, 9400), usage(22000, 17000, 300)),
  ];
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenvisillo-'));
  const claudeDir = path.join(dir, 'claude');
  const codexDir = path.join(dir, 'codex');
  const cFile = path.join(claudeDir, 'projects', '-work-app', 'c1.jsonl');
  const xFile = path.join(codexDir, 'sessions', '2026', '10', '10', 'rollout-2026-10-10T08-00-00-x1.jsonl');
  fs.mkdirSync(path.dirname(cFile), { recursive: true });
  fs.mkdirSync(path.dirname(xFile), { recursive: true });
  // A subagent transcript in a nested folder must be ignored.
  fs.mkdirSync(path.join(path.dirname(cFile), 'c1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(cFile), 'c1', 'subagents', 'agent.jsonl'), jsonl(claudeFixture()));
  const monitor = new Monitor({ claudeDir, codexDir, maxAgeMs: 3_600_000, maxSessions: 10 });
  return { monitor, cFile, xFile };
}

test('Claude Code session: context, totals, dedupe, compaction and advice', async () => {
  const { monitor, cFile } = setup();
  fs.writeFileSync(cFile, jsonl(claudeFixture()));
  const [s, ...rest] = await monitor.refresh();
  assert.equal(rest.length, 0);
  assert.equal(s.tool, 'claude');
  assert.equal(s.id, 'c1');
  assert.equal(s.cwd, '/work/app');
  assert.equal(s.model, 'claude-sonnet-5-5');
  assert.equal(s.title, 'Refactor the auth module');
  assert.equal(s.turns, 2);
  assert.equal(s.requests, 6); // m1 once, m2..m5, s1
  assert.equal(s.contextTokens, 135000);
  assert.equal(s.contextWindow, 200000);
  assert.equal(s.windowKnown, false);
  assert.equal(s.baselineTokens, 40000);
  assert.equal(s.input, 2000 + 100 * 4 + 5000);
  assert.equal(s.cacheRead, 40000 + 56000 + 130000);
  assert.equal(s.output, 500 + 900 + 300 + 400 + 100 + 4900);
  assert.equal(s.compactions, 1);
  assert.equal(s.cacheRebuilds, 1); // m4 only; m5 follows a compaction
  assert.equal(s.toolCalls, 4);
  assert.deepEqual(s.bigOutputs, [{ name: 'Bash', tokens: 15000 }]);
  assert.equal(s.repeats['/work/app/auth.ts'], 3);

  const r = analyze(s, T);
  assert.equal(Math.round(r.percent), 68);
  assert.equal(r.level, 'yellow');
  const ids = r.advice.map((a) => a.id);
  assert.deepEqual(ids.sort(), ['bigOutputs', 'compactions', 'contextHigh', 'heavyBaseline', 'repeats'].sort());
  assert.equal(r.advice[0].id, 'contextHigh'); // most severe first
  assert.equal(r.score, 100 - 12 - 5 * 4);
  assert.equal(r.grade, 'C');
});

test('Codex session: prompts from items, editor context stripped, limits, advice', async () => {
  const { monitor, xFile } = setup();
  fs.writeFileSync(xFile, jsonl(codexFixture()));
  const [s] = await monitor.refresh();
  assert.equal(s.tool, 'codex');
  assert.equal(s.id, 'x1');
  assert.equal(s.cwd, '/work/api');
  assert.equal(s.model, 'gpt-5-codex');
  assert.equal(s.title, 'Fix the failing endpoint');
  assert.equal(s.turns, 1);
  assert.equal(s.requests, 2);
  assert.equal(s.input, 205000);
  assert.equal(s.cacheRead, 5000);
  assert.equal(s.output, 3000);
  assert.equal(s.contextTokens, 182000);
  assert.equal(s.contextWindow, 200000);
  assert.equal(s.windowKnown, true);
  assert.equal(s.compactions, 1); // logged twice, counted once
  assert.equal(s.cacheRebuilds, 1);
  assert.equal(s.toolCalls, 4);
  assert.deepEqual(s.bigOutputs, [{ name: 'exec', tokens: 12000 }]);
  assert.deepEqual(s.repeats, { 'cat src/big.json': 3 }); // spawn_agent is not a command
  assert.deepEqual(s.limits, [{ minutes: 10080, usedPercent: 57 }]);

  const r = analyze(s, T);
  assert.equal(r.level, 'red');
  assert.equal(r.advice[0].id, 'contextCritical');
  assert.ok(r.advice.some((a) => a.id === 'heavyBaseline'));
  const [card] = buildCards([s], T, 'es');
  assert.ok(card.stats.some((x) => x.label === 'Límite semanal' && x.value === '57% usado'));
});

test('Codex resumed conversation: restarted totals are added up, prompts not double counted', async () => {
  const { monitor, xFile } = setup();
  fs.writeFileSync(xFile, jsonl(codexResumedFixture()));
  const [s] = await monitor.refresh();
  assert.equal(s.turns, 1); // logged as event and as item
  assert.equal(s.requests, 4);
  assert.equal(s.input + s.cacheRead, 20000 + 25000 + 26000 + 28000);
  assert.equal(s.cacheRead, 20000 + 26000);
  assert.equal(s.output, 500 + 400 + 300 + 400);
  assert.equal(s.contextTokens, 28400);
  assert.equal(s.cacheRebuilds, 1); // the first request after resuming read nothing from cache
});

test('Codex subagent: replayed parent history is ignored and it nests under its parent', async () => {
  const { monitor, xFile } = setup();
  fs.writeFileSync(xFile, jsonl(codexFixture()));
  const subFile = path.join(path.dirname(xFile), 'rollout-2026-10-10T08-30-00-sub1.jsonl');
  fs.writeFileSync(subFile, jsonl(codexSubagentFixture()));
  const list = await monitor.refresh();
  assert.equal(list.length, 1);
  const parent = list[0];
  assert.equal(parent.id, 'x1');
  assert.equal(parent.children!.length, 1);
  const sub = parent.children![0];
  assert.equal(sub.id, 'sub1'); // not overwritten by the replayed parent meta
  assert.equal(sub.cwd, '/work/api');
  assert.equal(sub.agent, 'review_lab (senior_dev)');
  assert.equal(sub.turns, 0);
  assert.equal(sub.requests, 2);
  assert.equal(sub.input + sub.cacheRead + sub.output, 40400); // own usage, not the parent's 2M
  assert.equal(sub.baselineTokens, 18000);
  assert.equal(sub.contextTokens, 22300);
  assert.equal(sub.compactions, 0);
  assert.equal(sub.cacheRebuilds, 0);
  assert.equal(parent.activeAt, sub.updatedAt);

  const [card] = buildCards(list, T, 'en');
  assert.equal(card.childrenLabel, 'Subagents: 1 · 40.4k tokens');
  assert.deepEqual(card.children, [{ name: 'review_lab (senior_dev)', level: 'green', percent: 11, tokens: '40.4k' }]);
});

test('incremental tailing, partial lines and both tools in one list', async () => {
  const { monitor, cFile, xFile } = setup();
  const rows = claudeFixture();
  const full = jsonl(rows);
  const cut = jsonl(rows.slice(0, 5)).length + 40; // ends in the middle of a line
  fs.writeFileSync(cFile, full.slice(0, cut));
  fs.writeFileSync(xFile, jsonl(codexFixture()));
  let list = await monitor.refresh();
  assert.equal(list.length, 2);
  const c1 = list.find((s) => s.tool === 'claude')!;
  assert.equal(c1.requests, 2);
  assert.equal(c1.contextTokens, 57000);

  fs.appendFileSync(cFile, full.slice(cut));
  list = await monitor.refresh();
  const c2 = list.find((s) => s.tool === 'claude')!;
  assert.equal(c2.requests, 6);
  assert.equal(c2.contextTokens, 135000);
  assert.equal(c2.repeats['/work/app/auth.ts'], 3); // no double counting after the append

  // Unchanged files are not re-parsed.
  list = await monitor.refresh();
  assert.equal(list.find((s) => s.tool === 'claude')!.requests, 6);
});

test('1M window is inferred, garbage lines are skipped, cards localize per tool', async () => {
  const { monitor, cFile, xFile } = setup();
  fs.writeFileSync(cFile, 'not json\n' + jsonl([
    claudeUser(0, 'hi'),
    claudeAssistant('m1', 1, { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 300000, output_tokens: 10 }),
  ]));
  fs.writeFileSync(xFile, jsonl(codexFixture()));
  const list = await monitor.refresh();
  const c = list.find((s) => s.tool === 'claude')!;
  assert.equal(c.contextWindow, 1_000_000);

  const es = buildCards(list, T, 'es');
  const en = buildCards(list, T, 'en');
  const codexEs = es.find((x) => x.toolId === 'codex')!;
  const codexEn = en.find((x) => x.toolId === 'codex')!;
  assert.equal(codexEs.level, 'red');
  assert.match(codexEs.tips[0].text, /Contexto al 91%.*\/new/);
  assert.match(codexEn.tips[0].text, /Context is 91% full.*\/new/);
  assert.ok(codexEn.tips.some((t) => t.text.includes('AGENTS.md')));
  const claudeEs = es.find((x) => x.toolId === 'claude')!;
  assert.ok(claudeEs.tips.some((t) => t.text.includes('CLAUDE.md')));
  assert.equal(claudeEs.estimated, true);
});
