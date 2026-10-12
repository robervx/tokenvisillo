# TokenVisillo

The nosy neighbour behind the curtain, watching your tokens. A traffic-light context meter and token-saving coach for **Claude Code** and **Codex**, inside VS Code.
One panel, one set of rules, whichever of the two you are using.

[Español más abajo](#español)

> **Why the name?** A *visillo* is a net curtain. In Spain, *la vieja del visillo* is the neighbour who peeks from behind it and knows everything that happens on the street. This one only spies on your tokens.

## What it does

- **Status bar light.** Shows the active conversation's context fill and an efficiency grade (A–E). Green, yellow or red as the window fills up.
- **One card per conversation.** Context bar, cache reuse, prompts, compactions and tokens used, for Claude Code and Codex side by side.
- **Subagents and limits.** Subagent conversations are nested under the one that spawned them, with their own context and spend. Codex cards also show the account usage limit written in the log.
- **Advice from your own sessions.** Each tip states what was measured before saying what to do: which command returned the huge output, how long the pause was that cost you the cache and how many tokens it re-read, how many requests are left at the current pace. The same rules run on both tools and are worded with each tool's commands (`/clear` vs `/new`, `CLAUDE.md` vs `AGENTS.md`).
- **Your patterns.** Above the cards, up to three habits that repeat across your recent conversations, each with the one change that would break it.
- **Local and read-only.** It reads the session logs both tools already write to disk. No network requests, no credentials, no telemetry.

## Advice rules

| Rule | Triggers when |
| --- | --- |
| Context critical / high | Context fill crosses the red / yellow threshold |
| Compactions | The conversation has been compacted (warning from the second one) |
| Low cache reuse | Under 50% of prompt tokens came from cache after 8+ requests |
| Cache rebuilds | A prompt over 20k tokens was sent with less than half of it cached, 2+ times |
| Large tool results | A tool returned more than ~10k tokens |
| Repeated reads | The same file (Claude Code) or shell command (Codex) ran 3+ times |
| Heavy start | The first request already used 30k+ tokens or 15%+ of the window |
| Long conversation | 30+ prompts while context is yellow or red |
| Pasted text | Prompts with 8k+ characters |
| Subagents | 2+ subagents account for 10%+ of the conversation's tokens (costs points from 30%) |

The grade starts at 100 and loses 25 / 12 / 5 points per critical / warning / info item.

## Where the data comes from

| Tool | Location | Override |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` | `$CLAUDE_CONFIG_DIR` or `tokenvisillo.claudeDir` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `$CODEX_HOME` or `tokenvisillo.codexDir` |

Files are read incrementally: only what was appended since the last check is parsed.

## Install

Not on the Marketplace yet. Build the `.vsix` and install it:

```bash
git clone <this repo> && cd tokenvisillo
npm install
npm run package
code --install-extension tokenvisillo-0.1.0.vsix
```

To hack on it, open the folder in VS Code and press `F5`.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `tokenvisillo.language` | `auto` | `en`, `es` or follow VS Code |
| `tokenvisillo.scope` | `workspace` | Only conversations started in the open folder, or `all` |
| `tokenvisillo.warnPercent` / `criticalPercent` | 60 / 85 | Yellow and red thresholds |
| `tokenvisillo.notify` | `true` | Notification when a conversation turns red |
| `tokenvisillo.pollSeconds` | 3 | How often logs are re-read |
| `tokenvisillo.maxAgeHours` / `maxSessions` | 48 / 12 | Which conversations are listed |
| `tokenvisillo.claudeContextWindow` | 0 | 0 = auto |
| `tokenvisillo.codexContextWindow` | 0 | 0 = value logged by Codex |

## Known limits

- **Claude Code window size is inferred.** Its log does not record the window, so TokenVisillo assumes 200k and switches to 1M once a conversation exceeds 200k. Set `tokenvisillo.claudeContextWindow` if you always use a 1M model. Estimated values are marked with `~`.
- **Context fill is an approximation** of what each tool shows: it is the prompt plus output of the latest request, and does not include the space each tool reserves before auto-compacting.
- **Tool result sizes are estimated** at 4 characters per token.
- **Compressed Codex logs (`.jsonl.zst`) are not read.**
- **How far each parser has been checked.** Codex: against real logs written by Codex 0.107 to 0.153 (VS Code extension and SDK), where token totals match Codex's own per-thread records exactly. Claude Code: against a real 4.8 MB session log, where requests and every token total match exactly; subagent folders and compaction markers only against synthetic logs built from the publicly described format.
- **Inside VS Code** the extension has been run end to end (activation, status bar, panel, export) in a VS Code 1.112 server, not on every desktop build.
- **Codex compactions** are read from the `compacted` line Codex writes (confirmed on a real log from Codex 0.153). As a fallback for other versions, a prompt that suddenly halves is also counted as one.
- The log formats are not a public API and can change between versions. If a number looks wrong, please open an issue with the tool version and an anonymized log (see below).

## Reporting a wrong number

```bash
npm run compile && node tools/anonymize-log.js
```

(or the export button in the panel's toolbar, which needs no terminal) writes a copy of your newest Claude Code and Codex logs to a `tokenvisillo-anon` folder with all text replaced by `[str:LENGTH]`: prompts, answers, file contents, paths and commands are removed; structure, numbers and tool names stay. Attach those files to the issue.

## Contributing

The core (`src/core`) has no VS Code dependency, so rules and parsers can be tested with `npm test`.
To add a rule: add its id and condition in `advisor.ts`, its text in both languages in `i18n.ts`, and a case in `src/test`.

## License

MIT

---

## Español

La vecina del visillo, pero de tus tokens: lo ve todo y te lo cuenta. Medidor de contexto tipo semáforo y consejero de ahorro de tokens para **Claude Code** y **Codex**, dentro de VS Code. Un solo panel y las mismas reglas, uses la herramienta que uses.

### Qué hace

- **Semáforo en la barra de estado.** Muestra el llenado de contexto de la conversación activa y una nota de eficiencia (A–E). Verde, amarillo o rojo según se llena la ventana.
- **Una tarjeta por conversación.** Barra de contexto, uso de caché, prompts, compactaciones y tokens usados, con Claude Code y Codex juntos.
- **Subagentes y límites.** Las conversaciones de subagentes aparecen dentro de la que las lanzó, con su contexto y su gasto. Las tarjetas de Codex muestran además el límite de uso de la cuenta que figura en el registro.
- **Consejos a partir de tus propias sesiones.** Cada consejo dice primero qué ha medido y luego qué hacer: qué comando devolvió la salida enorme, cuánto duró la pausa que te costó la caché y cuántos tokens se releyeron, cuántas peticiones quedan al ritmo actual. Las mismas reglas se aplican a las dos herramientas, redactadas con los comandos de cada una (`/clear` o `/new`, `CLAUDE.md` o `AGENTS.md`).
- **Tus patrones.** Encima de las tarjetas, hasta tres hábitos que se repiten en tus conversaciones recientes, cada uno con el cambio que lo corta.
- **Local y solo lectura.** Lee los registros que ambas herramientas ya guardan en disco. Sin peticiones de red, sin credenciales, sin telemetría.

### Reglas de consejo

| Regla | Se activa cuando |
| --- | --- |
| Contexto crítico / alto | El llenado supera el umbral rojo / amarillo |
| Compactaciones | La conversación se ha compactado (aviso a partir de la segunda) |
| Poca caché | Menos del 50% del prompt salió de caché tras 8 o más peticiones |
| Caché reconstruida | Un prompt de más de 20k tokens se envió con menos de la mitad en caché, 2 o más veces |
| Resultados grandes | Una herramienta devolvió más de ~10k tokens |
| Lecturas repetidas | El mismo archivo (Claude Code) o comando (Codex) se ejecutó 3 o más veces |
| Arranque pesado | La primera petición ya usó 30k tokens o el 15% de la ventana |
| Conversación larga | 30 o más prompts con el contexto en amarillo o rojo |
| Texto pegado | Prompts de 8k caracteres o más |
| Subagentes | 2 o más subagentes suman el 10% o más de los tokens de la conversación (resta puntos desde el 30%) |

La nota parte de 100 y pierde 25 / 12 / 5 puntos por cada consejo crítico / aviso / informativo.

### Instalación

Todavía no está en el Marketplace:

```bash
git clone <este repo> && cd tokenvisillo
npm install
npm run package
code --install-extension tokenvisillo-0.1.0.vsix
```

### Límites conocidos

- **El tamaño de ventana de Claude Code se deduce**: 200k por defecto y 1M cuando una conversación pasa de 200k. Se puede fijar con `tokenvisillo.claudeContextWindow`. Los valores estimados llevan `~`.
- **El llenado de contexto es una aproximación** de lo que muestra cada herramienta; no incluye el margen que reservan antes de compactar.
- **El tamaño de los resultados de herramientas se estima** a 4 caracteres por token.
- **No se leen los registros de Codex comprimidos (`.jsonl.zst`).**
- **Hasta dónde está comprobado cada lector.** Codex: con registros reales de Codex 0.107 a 0.153, donde los totales coinciden exactamente con los que Codex anota por hilo. Claude Code: con un registro real de 4,8 MB, donde las peticiones y todos los totales de tokens coinciden exactamente; las carpetas de subagentes y las compactaciones, solo con registros sintéticos construidos según el formato descrito públicamente.
- **Dentro de VS Code** se ha probado de principio a fin (activación, barra de estado, panel, exportación) en un servidor de VS Code 1.112, no en todas las versiones de escritorio.
- **Las compactaciones de Codex** se leen de la línea `compacted` que escribe Codex (confirmado con un registro real de Codex 0.153). Como respaldo para otras versiones, también cuenta un prompt que se reduce de golpe a la mitad.
- Los formatos de registro no son una API pública y pueden cambiar entre versiones.

### Avisar de un número incorrecto

El botón de exportar de la barra del panel (o `npm run compile && node tools/anonymize-log.js`) crea en una carpeta `tokenvisillo-anon` una copia de tus registros más recientes con todo el texto sustituido por `[str:LONGITUD]`. Se conservan la estructura, las cifras y los nombres de herramientas. Adjunta esos archivos a la incidencia.
