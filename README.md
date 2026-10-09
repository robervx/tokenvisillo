# TokenVisillo

The nosy neighbour behind the curtain, watching your tokens. A traffic-light context meter and token-saving coach for **Claude Code** and **Codex**, inside VS Code.
One panel, one set of rules, whichever of the two you are using.

[Español más abajo](#español)

> **Why the name?** A *visillo* is a net curtain. In Spain, *la vieja del visillo* is the neighbour who peeks from behind it and knows everything that happens on the street. This one only spies on your tokens.

## What it does

- **Status bar light.** Shows the active conversation's context fill and an efficiency grade (A–E). Green, yellow or red as the window fills up.
- **One card per conversation.** Context bar, cache reuse, prompts, compactions and tokens used, for Claude Code and Codex side by side.
- **Advice from your own sessions.** The same rules run on both tools and are worded with each tool's commands (`/clear` vs `/new`, `CLAUDE.md` vs `AGENTS.md`).
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
- The log formats are not a public API and can change between versions. Parsers were written against the formats in use in October 2026; if a number looks wrong, please open an issue with the tool version.
- Tested with synthetic sessions (`npm test`). Reports from real-world use are welcome.

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
- **Consejos a partir de tus propias sesiones.** Las mismas reglas se aplican a las dos herramientas, redactadas con los comandos de cada una (`/clear` o `/new`, `CLAUDE.md` o `AGENTS.md`).
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
- Los formatos de registro no son una API pública y pueden cambiar entre versiones.
- Probado con sesiones sintéticas (`npm test`).
