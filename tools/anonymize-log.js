#!/usr/bin/env node
/*
 * Writes copies of your newest Claude Code and Codex session logs with every piece of text
 * removed, so they can be attached to a bug report. Structure, numbers and tool names are
 * kept; prompts, answers, file contents, paths and commands become "[str:LENGTH]".
 *
 *   npm run compile && node tools/anonymize-log.js [output folder]
 *
 * The same export is available inside VS Code from the TokenVisillo panel's toolbar.
 * Nothing is sent anywhere.
 */
const path = require('path');
const { exportAnonymized } = require('../out/core/anonymize.js');

const outDir = path.resolve(process.argv[2] || 'tokenvisillo-anon');
const files = exportAnonymized(outDir);
console.log(files.length ? files.join('\n') : 'No session logs found.');
