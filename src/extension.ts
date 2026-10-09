import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Monitor, MonitorOptions } from './core/monitor';
import { Session } from './core/types';
import { analyze, Thresholds } from './core/advisor';
import { adviceText, Lang, pickLang, TOOL_NAME, UI } from './core/i18n';
import { buildCards, buildHabits } from './core/viewmodel';
import { exportAnonymized } from './core/anonymize';
import { panelHtml } from './panel';

const cfg = () => vscode.workspace.getConfiguration('tokenvisillo');

function monitorOptions(): MonitorOptions {
  const c = cfg();
  return {
    claudeDir: c.get<string>('claudeDir') || undefined,
    codexDir: c.get<string>('codexDir') || undefined,
    maxAgeMs: c.get<number>('maxAgeHours', 48) * 3_600_000,
    maxSessions: c.get<number>('maxSessions', 12),
    claudeContextWindow: c.get<number>('claudeContextWindow', 0),
    codexContextWindow: c.get<number>('codexContextWindow', 0),
  };
}

const thresholds = (): Thresholds => ({
  warnPercent: cfg().get<number>('warnPercent', 60),
  criticalPercent: cfg().get<number>('criticalPercent', 85),
});

const norm = (p: string) => {
  const n = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
};

function inWorkspace(s: Session): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return true;
  if (!s.cwd) return false;
  const cwd = norm(s.cwd);
  return folders.some((f) => {
    const root = norm(f.uri.fsPath);
    return cwd === root || cwd.startsWith(root + path.sep) || root.startsWith(cwd + path.sep);
  });
}

class PanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private last: unknown;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = panelHtml();
    view.webview.onDidReceiveMessage((m) => {
      if (m?.type === 'ready' && this.last) view.webview.postMessage(this.last);
    });
    view.onDidDispose(() => (this.view = undefined));
  }

  post(data: unknown): void {
    this.last = data;
    this.view?.webview.postMessage(data);
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  const monitor = new Monitor(monitorOptions());
  const panel = new PanelProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'tokenvisillo.openPanel';
  const notified = new Set<string>();
  let busy = false;
  let timer: NodeJS.Timeout | undefined;

  const update = async () => {
    if (busy) return;
    busy = true;
    try {
      const lang: Lang = pickLang(cfg().get<string>('language', 'auto'), vscode.env.language);
      const ui = UI[lang];
      const t = thresholds();
      const scope = cfg().get<string>('scope', 'workspace');
      const all = await monitor.refresh();
      const sessions = scope === 'all' ? all : all.filter(inWorkspace);

      panel.post({
        type: 'update',
        cards: buildCards(sessions, t, lang),
        habits: buildHabits(sessions, t, lang),
        ui,
        scopeLabel: scope === 'all' ? ui.scopeAll : ui.scopeWs,
        emptyText: all.length === 0 ? ui.empty : ui.emptyScope,
      });

      // An orphaned subagent log is never "the" conversation while a real one exists.
      const active = sessions.find((s) => !s.parentId) ?? sessions[0];
      if (!active) {
        status.text = '$(circle-outline) TokenVisillo';
        status.tooltip = ui.idle;
        status.color = undefined;
        status.backgroundColor = undefined;
        status.show();
        return;
      }
      const r = analyze(active, t);
      const pct = Math.round(r.percent);
      status.text = `$(circle-filled) ${TOOL_NAME[active.tool]} ${pct}% · ${r.grade}`;
      status.color = r.level === 'green' ? new vscode.ThemeColor('charts.green') : undefined;
      status.backgroundColor =
        r.level === 'red' ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : r.level === 'yellow' ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${TOOL_NAME[active.tool]}** · ${ui.context} ${pct}% · ${ui.score} ${r.grade} (${r.score})\n\n`);
      md.appendText(active.title ?? ui.untitled);
      for (const a of r.advice.slice(0, 3)) {
        md.appendMarkdown('\n\n- ');
        md.appendText(adviceText(a, active.tool, lang));
      }
      status.tooltip = md;
      status.show();

      if (cfg().get<boolean>('notify', true)) {
        if (r.level === 'red' && !notified.has(active.file)) {
          notified.add(active.file);
          const msg = `TokenVisillo: ${TOOL_NAME[active.tool]} — ${ui.critical.replace('{pct}', String(pct))}`;
          vscode.window.showWarningMessage(msg, ui.open).then((pick) => {
            if (pick) vscode.commands.executeCommand('tokenvisillo.openPanel');
          });
        } else if (r.level !== 'red') {
          // Re-arm after a compaction brings the conversation back down.
          notified.delete(active.file);
        }
      }
    } catch (err) {
      console.error('[TokenVisillo]', err);
    } finally {
      busy = false;
    }
  };

  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(update, Math.max(1, cfg().get<number>('pollSeconds', 3)) * 1000);
  };

  ctx.subscriptions.push(
    status,
    vscode.window.registerWebviewViewProvider('tokenvisillo.sessions', panel),
    vscode.commands.registerCommand('tokenvisillo.refresh', update),
    vscode.commands.registerCommand('tokenvisillo.openPanel', () =>
      vscode.commands.executeCommand('tokenvisillo.sessions.focus')),
    vscode.commands.registerCommand('tokenvisillo.exportAnonymized', async () => {
      const ui = UI[pickLang(cfg().get<string>('language', 'auto'), vscode.env.language)];
      const desktop = path.join(os.homedir(), 'Desktop');
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: ui.exportPick,
        defaultUri: vscode.Uri.file(fs.existsSync(desktop) ? desktop : os.homedir()),
      });
      if (!picked?.length) return;
      const dir = path.join(picked[0].fsPath, 'tokenvisillo-anon');
      try {
        const o = monitorOptions();
        const files = exportAnonymized(dir, { claudeDir: o.claudeDir, codexDir: o.codexDir });
        if (!files.length) vscode.window.showInformationMessage('TokenVisillo: ' + ui.exportNone);
        else vscode.window.showInformationMessage('TokenVisillo: ' + ui.exportDone.replace('{dir}', dir).replace('{n}', String(files.length)));
      } catch (err) {
        vscode.window.showErrorMessage('TokenVisillo: ' + String(err));
      }
    }),
    vscode.commands.registerCommand('tokenvisillo.toggleScope', async () => {
      const next = cfg().get<string>('scope', 'workspace') === 'all' ? 'workspace' : 'all';
      await cfg().update('scope', next, vscode.ConfigurationTarget.Global);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('tokenvisillo')) return;
      monitor.setOptions(monitorOptions());
      schedule();
      update();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(update),
    { dispose: () => timer && clearInterval(timer) },
  );

  schedule();
  update();
}

export function deactivate(): void {}
