#!/usr/bin/env node
// Installs slop-hook into the git repo you run it from.
//
//   node <path-to-slop-teller>/hook/install.mjs [options]
//
//   --mode warn|ask|block   how strict it is (default warn; saved to .slophook.json)
//   --agents                add a note for AI coding agents to AGENTS.md / CLAUDE.md /
//                           GEMINI.md / .github/copilot-instructions.md (the ones that exist;
//                           creates AGENTS.md if none do)
//   --agent-files a,b       pick the agent files yourself, e.g. AGENTS.md,CLAUDE.md
//   --uninstall             remove the hook, its files and the agent notes
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_RULES = path.join(HERE, '..', 'src', 'rules.js');
const HOOK_START = '# >>> slop-hook >>>';
const HOOK_END = '# <<< slop-hook <<<';
const HOOK_LINES = [HOOK_START, 'sh "$(git rev-parse --git-common-dir)/slop-hook/run.sh" || exit 1', HOOK_END];
const NOTE_START = '<!-- slop-hook:start -->';
const NOTE_END = '<!-- slop-hook:end -->';
const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : null;
};

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let root;
try {
  root = git(['rev-parse', '--show-toplevel']);
} catch (e) {
  console.error('Run this from inside the git repo you want to protect.');
  process.exit(1);
}
const gitDir = path.resolve(root, git(['rev-parse', '--git-common-dir']));
const toolDir = path.join(gitDir, 'slop-hook');

function hooksDir() {
  let p = '';
  try {
    p = git(['config', '--get', 'core.hooksPath']);
  } catch (e) {
    p = '';
  }
  if (p) {
    const abs = path.resolve(root, p);
    // husky v9 points hooksPath at .husky/_ ; its user-editable hooks live in .husky/
    if (/[\\/]\.husky[\\/]_$/.test(abs)) return path.dirname(abs);
    return abs;
  }
  return path.join(gitDir, 'hooks');
}

const noteText = () => `${NOTE_START}
## AI tell check on commit (slop-hook)

This repo runs slop-hook before each commit. It checks the copy being committed for AI tells (em dashes, stock phrases, "not just X, it's Y" lines, emoji bullets, placeholder content) and prints them as \`file:line\` warnings. By default the commit still goes through.

When you commit or push in this repo:
- Read the slop-hook output after \`git commit\`.
- If it lists tells, tell the user in your reply: how many, and each \`file:line\` with the flagged text. Say whether the commit went through.
- Don't fix them, add \`slop-ok\`, edit \`.slophook.json\`, or commit with \`--no-verify\` unless the user asks. The user decides what stays.
- To check the whole repo without committing: \`node "$(git rev-parse --git-common-dir)/slop-hook/slop-hook.mjs" --all\`
${NOTE_END}`;

function stripBlock(text, start, end) {
  const re = new RegExp(`\\n?${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g');
  return text.replace(re, '\n');
}

function eol(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

// ---------- uninstall ----------

if (flag('--uninstall')) {
  const hook = path.join(hooksDir(), 'pre-commit');
  if (fs.existsSync(hook)) {
    const left = stripBlock(fs.readFileSync(hook, 'utf8').replace(/\r\n/g, '\n'), HOOK_START, HOOK_END);
    if (!left.replace(/^#!.*\n?/, '').trim()) fs.rmSync(hook);
    else fs.writeFileSync(hook, left.replace(/\n{3,}/g, '\n\n'));
  }
  fs.rmSync(toolDir, { recursive: true, force: true });
  const touched = [];
  for (const rel of AGENT_FILES) {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8');
    if (!raw.includes(NOTE_START)) continue;
    const nl = eol(raw);
    const left = stripBlock(raw.replace(/\r\n/g, '\n'), NOTE_START, NOTE_END).replace(/\n{3,}/g, '\n\n').trim();
    if (!left) fs.rmSync(f);
    else fs.writeFileSync(f, (left + '\n').replace(/\n/g, nl));
    touched.push(rel);
  }
  console.log('slop-hook removed.' + (touched.length ? ` Agent notes removed from ${touched.join(', ')}.` : ''));
  process.exit(0);
}

// ---------- install ----------

fs.mkdirSync(toolDir, { recursive: true });
fs.copyFileSync(path.join(HERE, 'slop-hook.mjs'), path.join(toolDir, 'slop-hook.mjs'));
fs.copyFileSync(path.join(HERE, 'run.sh'), path.join(toolDir, 'run.sh'));
fs.copyFileSync(SRC_RULES, path.join(toolDir, 'rules.js'));

const dir = hooksDir();
fs.mkdirSync(dir, { recursive: true });
const hook = path.join(dir, 'pre-commit');
let body = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8').replace(/\r\n/g, '\n') : '#!/bin/sh\n';
body = stripBlock(body, HOOK_START, HOOK_END);
// Put our line right after the shebang so an "exit 0" further down can't skip it.
// In warn mode it never fails, so running first is safe for whatever follows.
const lines = body.split('\n');
const at = lines[0].startsWith('#!') ? 1 : 0;
lines.splice(at, 0, ...HOOK_LINES);
fs.writeFileSync(hook, lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n'));
fs.chmodSync(hook, 0o755);

const done = [`hook: ${path.relative(root, hook) || hook}`];

const mode = value('--mode');
if (mode) {
  if (!['warn', 'ask', 'block'].includes(mode)) {
    console.error(`Unknown --mode "${mode}". Use warn, ask or block.`);
    process.exit(1);
  }
  const cfgFile = path.join(root, '.slophook.json');
  let cfg = {};
  if (fs.existsSync(cfgFile)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch (e) {
      cfg = {};
    }
  }
  cfg.mode = mode;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  done.push(`mode: ${mode} (.slophook.json)`);
} else {
  done.push('mode: warn');
}

if (flag('--agents') || value('--agent-files')) {
  const chosen = value('--agent-files');
  let targets = chosen ? chosen.split(',').map((s) => s.trim()).filter(Boolean) : AGENT_FILES.filter((f) => fs.existsSync(path.join(root, f)));
  let created = [];
  if (!targets.length) targets = ['AGENTS.md'];
  for (const rel of targets) {
    const f = path.join(root, rel);
    const exists = fs.existsSync(f);
    if (!exists) created.push(rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const raw = exists ? fs.readFileSync(f, 'utf8') : '';
    const nl = raw ? eol(raw) : '\n';
    let text = stripBlock(raw.replace(/\r\n/g, '\n'), NOTE_START, NOTE_END).replace(/\n{3,}/g, '\n\n').trimEnd();
    text = (text ? text + '\n\n' : '') + noteText() + '\n';
    fs.writeFileSync(f, text.replace(/\n/g, nl));
  }
  done.push(`agent note: ${targets.join(', ')}${created.length ? ` (created ${created.join(', ')})` : ''}`);
}

console.log('slop-hook installed.\n  ' + done.join('\n  '));
console.log('Try it: stage a file and commit. Check everything now: node "' + path.join(toolDir, 'slop-hook.mjs').replace(/\\/g, '/') + '" --all');
if ((flag('--agents') || value('--agent-files')) && !fs.existsSync(path.join(root, 'CLAUDE.md')) && !(value('--agent-files') || '').includes('CLAUDE.md')) {
  console.log('Note: Claude Code reads CLAUDE.md. Add --agent-files AGENTS.md,CLAUDE.md if you use it.');
}
