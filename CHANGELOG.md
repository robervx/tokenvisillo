# Changelog

## 0.1.0

First public version.

- Context meter for Claude Code and Codex in the status bar and a side panel, one card per conversation.
- Subagents nested under the conversation that spawned them (Codex and Claude Code).
- Advice that states what was measured: the command behind a huge tool output, the pause that cost the cache and how many tokens it re-read, requests left at the current pace, the costliest subagent.
- "Your patterns": habits that repeat across recent conversations.
- Codex account usage limits (5-hour and weekly) when the log includes them.
- Export of anonymized logs for bug reports.
- English and Spanish.
- Checked against real logs: Codex 0.107 to 0.153, and a Claude Code session.
