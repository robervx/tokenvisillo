import * as crypto from 'crypto';

/** Sidebar webview. It only renders the cards the extension sends; all text is set via textContent. */
export function panelHtml(): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  :root { --green: var(--vscode-charts-green, #3fb950); --yellow: var(--vscode-charts-yellow, #d29922); --red: var(--vscode-charts-red, #f85149); }
  body { padding: 8px 10px 16px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .scope { opacity: .7; font-size: .85em; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .04em; }
  .empty { opacity: .75; padding: 12px 2px; line-height: 1.4; }
  .card { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3)); border-left-width: 4px; border-radius: 4px; padding: 9px 10px; margin-bottom: 10px; background: var(--vscode-sideBarSectionHeader-background, transparent); }
  .card.green { border-left-color: var(--green); } .card.yellow { border-left-color: var(--yellow); } .card.red { border-left-color: var(--red); }
  .head { display: flex; align-items: center; gap: 6px; }
  .tool { font-weight: 600; }
  .model { opacity: .65; font-size: .85em; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grade { font-weight: 700; border-radius: 3px; padding: 0 6px; border: 1px solid currentColor; }
  .title { margin: 4px 0 8px; opacity: .9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 8px; border-radius: 4px; background: var(--vscode-progressBar-background, rgba(128,128,128,.25)); background: rgba(128,128,128,.25); overflow: hidden; }
  .fill { height: 100%; border-radius: 4px; transition: width .3s; }
  .green .fill { background: var(--green); } .yellow .fill { background: var(--yellow); } .red .fill { background: var(--red); }
  .ctx { display: flex; justify-content: space-between; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .ctx .pct { font-weight: 600; }
  .ctx .est { opacity: .6; font-size: .85em; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 8px 0 0; font-size: .92em; }
  dt { opacity: .7; } dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  h4 { margin: 10px 0 4px; font-size: .85em; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { padding: 4px 0 4px 14px; position: relative; line-height: 1.35; }
  li::before { content: ''; position: absolute; left: 0; top: .75em; width: 7px; height: 7px; border-radius: 50%; }
  li.crit::before { background: var(--red); } li.warn::before { background: var(--yellow); } li.info::before { background: var(--vscode-charts-blue, #58a6ff); }
  .ok { opacity: .7; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  function render(d) {
    root.replaceChildren();
    root.append(el('div', 'scope', d.scopeLabel));
    if (!d.cards.length) { root.append(el('div', 'empty', d.emptyText)); return; }
    for (const c of d.cards) {
      const card = el('div', 'card ' + c.level);
      const head = el('div', 'head');
      head.append(el('span', 'tool', c.tool), el('span', 'model', c.model), el('span', 'grade', c.grade));
      head.lastChild.title = d.ui.score + ': ' + c.score + '/100';
      const title = el('div', 'title', c.title);
      title.title = c.title;
      const bar = el('div', 'bar');
      const fill = el('div', 'fill');
      fill.style.width = Math.max(2, c.percent) + '%';
      bar.append(fill);
      const ctx = el('div', 'ctx');
      ctx.append(el('span', 'pct', d.ui.context + ' ' + c.percent + '%'));
      const right = el('span', '', c.contextLabel);
      if (c.estimated) { right.append(el('span', 'est', ' ~')); right.title = d.ui.estimated; }
      ctx.append(right);
      const dl = el('dl');
      for (const s of c.stats) dl.append(el('dt', '', s.label), el('dd', '', s.value));
      card.append(head, title, bar, ctx, dl, el('h4', '', d.ui.tips));
      if (c.tips.length) {
        const ul = el('ul');
        for (const t of c.tips) ul.append(el('li', t.severity, t.text));
        card.append(ul);
      } else {
        card.append(el('div', 'ok', d.ui.noTips));
      }
      root.append(card);
    }
  }
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'update') render(e.data); });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
