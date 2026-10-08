#!/usr/bin/env node
// slop-hook: checks the copy you're about to commit for AI tells.
// Uses the same rules as the Slop Teller extension (src/rules.js).
//
// Exit codes (read by run.sh):
//   0  nothing found, or findings in "warn" mode (the commit continues)
//   20 findings in "ask" mode (run.sh asks the user if it can reach a terminal)
//   1  findings in "block" mode (the commit stops)
//
// Run by hand:  node slop-hook.mjs [--all] [--json]
//   --all   check every tracked file instead of only the staged additions
//   --json  print findings as JSON (for scripts and agents)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

// ---------- rules (shared with the extension) ----------

function loadRules() {
  const candidates = [path.join(HERE, 'rules.js'), path.join(HERE, '..', 'src', 'rules.js')];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error('slop-hook: rules.js not found next to the hook. Reinstall it.');
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return ctx.SlopRules;
}

// ---------- config ----------

const DEFAULTS = {
  mode: 'warn', // warn | ask | block
  off: [], // rule ids to skip, e.g. ["em-dash"]
  ignore: [], // path globs to skip, e.g. ["docs/legal/**"]
  extensions: ['.html', '.htm', '.md', '.mdx', '.markdown', '.txt', '.astro', '.vue', '.svelte', '.jsx', '.tsx', '.js', '.ts', '.json', '.yml', '.yaml', '.php', '.liquid', '.njk', '.hbs', '.ejs'],
};
const ALWAYS_SKIP = [/(^|\/)node_modules\//, /(^|\/)(dist|build|out|\.next|\.astro|\.svelte-kit|coverage|vendor)\//, /(^|\/)(package-lock|pnpm-lock|yarn\.lock|composer\.lock)/, /\.min\.(js|css)$/, /(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$/, /(^|\/)\.github\/copilot-instructions\.md$/, /(^|\/)\.slophook\.json$/];

function git(argv, opts = {}) {
  return execFileSync('git', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function loadConfig(root) {
  const f = path.join(root, '.slophook.json');
  let cfg = {};
  if (fs.existsSync(f)) {
    try {
      cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      console.error(`slop-hook: ignoring .slophook.json (${e.message})`);
    }
  }
  const envMode = process.env.SLOP_HOOK_MODE;
  const merged = { ...DEFAULTS, ...cfg };
  if (envMode) merged.mode = envMode;
  if (!['warn', 'ask', 'block'].includes(merged.mode)) merged.mode = 'warn';
  return merged;
}

function globToRe(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp('^' + re + '$');
}

// ---------- what to check ----------

// Staged, added lines only: [{file, line, text}]
function stagedAdditions() {
  const diff = git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR']);
  const out = [];
  let file = null;
  let ln = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      ln = m ? Number(m[1]) : 0;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+')) {
      out.push({ file, line: ln, text: raw.slice(1) });
      ln++;
    }
  }
  return out;
}

function allTracked() {
  const out = [];
  for (const file of git(['ls-files']).split('\n').filter(Boolean)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    if (text.includes('\u0000')) continue;
    text.split(/\r?\n/).forEach((t, i) => out.push({ file, line: i + 1, text: t }));
  }
  return out;
}

// ---------- extracting the copy from a line ----------

const CODE_EXT = new Set(['.js', '.ts', '.jsx', '.tsx', '.json', '.vue', '.svelte', '.astro']);
const MARKUP_EXT = new Set(['.html', '.htm', '.php', '.liquid', '.njk', '.hbs', '.ejs']);

// Returns the human-readable text on a line, best effort.
function copyOf(file, text) {
  const ext = path.extname(file).toLowerCase();
  const t = text.trim();
  if (!t) return '';
  if (CODE_EXT.has(ext)) {
    // Skip comments and imports; keep string literals and JSX/template text.
    if (/^(\/\/|\/\*|\*|import\s|export\s+\*\s|#)/.test(t)) return '';
    const parts = [];
    const strRe = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = strRe.exec(t))) {
      const s = m[2];
      // skip things that look like code, paths, classes or URLs
      if (/^[\w./@:#?&=%-]*$/.test(s) && !/\s/.test(s)) continue;
      if (/^(?:[\w-]+:)?[\w-]+(?:\s+[\w:/[\]().%#-]+)+$/.test(s) && !/[A-Z][a-z]+\s+[a-z]+/.test(s) && /-/.test(s)) continue; // tailwind-ish class lists
      parts.push(s);
    }
    // JSX / template text between tags
    const tagText = t.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, ' ').match(/>([^<>{}]+)</g);
    if (tagText) parts.push(...tagText.map((x) => x.slice(1, -1)));
    if (/^[^<>{}=;()]+$/.test(t) && /[a-z]\s+[a-z]/i.test(t) && !/[;{}]$/.test(t) && ext !== '.json') parts.push(t); // bare JSX text line
    return parts.join(' \u2016 ');
  }
  if (MARKUP_EXT.has(ext) || ext === '.md' || ext === '.mdx') {
    return t.replace(/<[^>]+>/g, ' ').replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013').replace(/&nbsp;/g, ' ');
  }
  return t;
}

function isHeading(file, text) {
  const t = text.trim();
  return /^#{1,3}\s/.test(t) || /<h[1-3][\s>]/i.test(t);
}

function headingText(text) {
  return text.trim().replace(/^#{1,3}\s+/, '').replace(/<[^>]+>/g, ' ').trim();
}

// ---------- scanning ----------

function scan(lines, rules, cfg) {
  const ignoreRes = cfg.ignore.map(globToRe);
  const exts = new Set(cfg.extensions.map((e) => e.toLowerCase()));
  const off = new Set(cfg.off);
  const findings = [];
  const fp = rules.fingerprints;
  const builderRe = new RegExp(fp.builderPattern, 'i');

  for (const { file, line, text } of lines) {
    const norm = file.replace(/\\/g, '/');
    if (ALWAYS_SKIP.some((re) => re.test(norm))) continue;
    if (ignoreRes.some((re) => re.test(norm))) continue;
    if (!exts.has(path.extname(norm).toLowerCase())) continue;
    if (/slop-ok/i.test(text)) continue;
    if (text.length > 2000) continue; // minified or generated

    // builder fingerprints in markup: script/link/meta/badge pointing at a builder
    if (!off.has('builder-trace') && /<(script|link|meta|a|iframe|img)\b/i.test(text)) {
      const attr = text.match(/\b(?:src|href|content)\s*=\s*["']([^"']+)["']/gi) || [];
      const hit = attr.find((a) => builderRe.test(a));
      if (hit) findings.push({ file: norm, line, id: 'builder-trace', short: 'builder trace', match: hit.replace(/^\w+\s*=\s*/, '').replace(/["']/g, ''), text });
    }

    const copy = copyOf(norm, text);
    if (!copy) continue;
    const heading = isHeading(norm, text);

    for (const rule of rules.copy) {
      if (off.has(rule.id)) continue;
      const flags = (rule.flags || '').includes('i') ? rule.flags || '' : (rule.flags || '') + 'i';
      if (rule.scope === 'heading') {
        if (!heading) continue;
        const m = new RegExp(rule.pattern, flags).exec(headingText(text));
        if (m) findings.push({ file: norm, line, id: rule.id, short: rule.short, match: m[0].trim(), text, ctx: copy });
        continue;
      }
      if (rule.scope === 'whole') {
        for (const piece of copy.split(' \u2016 ')) {
          const p = piece.trim();
          if (p && p.length <= 120 && new RegExp(rule.pattern, flags).test(p)) findings.push({ file: norm, line, id: rule.id, short: rule.short, match: p, text, ctx: p });
        }
        continue;
      }
      if (rule.scope === 'body') {
        if (heading) continue;
        const body = copy.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
        const m = new RegExp(rule.pattern, flags).exec(body);
        if (m) findings.push({ file: norm, line, id: rule.id, short: rule.short, match: m[0].trim(), text, ctx: copy });
        continue;
      }
      const re = new RegExp(rule.pattern, flags + 'g');
      let m;
      while ((m = re.exec(copy))) {
        if (!m[0].length) {
          re.lastIndex++;
          continue;
        }
        findings.push({ file: norm, line, id: rule.id, short: rule.short, match: m[0].trim() || m[0], text, ctx: copy });
      }
    }
  }
  return findings;
}

// ---------- output ----------

const color = process.stderr.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);

function clip(s, n) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

function snippet(f) {
  // Show the copy itself (tags and quotes stripped) when we have it.
  const t = (f.ctx || f.text).replace(/ \u2016 /g, ' | ').replace(/\s+/g, ' ').trim();
  const i = t.toLowerCase().indexOf(f.match.toLowerCase());
  if (i < 0) return clip(t, 50);
  const a = Math.max(0, i - 18);
  const b = Math.min(t.length, i + f.match.length + 18);
  return (a > 0 ? '...' : '') + t.slice(a, b) + (b < t.length ? '...' : '');
}

function report(findings, cfg, mode) {
  const files = new Set(findings.map((f) => f.file));
  const n = findings.length;
  const tail = mode === 'block' ? c('31', 'commit stopped') : mode === 'ask' ? 'confirm to continue' : 'commit continues';
  const lines = [];
  lines.push(`${c('1', 'slop-hook:')} ${n} AI tell${n === 1 ? '' : 's'} in ${files.size} file${files.size === 1 ? '' : 's'} (${tail})`);
  const loc = (f) => `${f.file}:${f.line}`;
  const w = Math.min(42, Math.max(...findings.map((f) => loc(f).length)));
  const shown = findings.slice(0, 30);
  for (const f of shown) {
    lines.push(`  ${loc(f).padEnd(w)}  ${c('33', f.short.padEnd(15))} "${clip(snippet(f), 60)}"`);
  }
  if (findings.length > shown.length) lines.push(`  ...and ${findings.length - shown.length} more (run: node ${path.relative(process.cwd(), path.join(HERE, 'slop-hook.mjs')) || 'slop-hook.mjs'} --all)`);
  lines.push(c('2', '  Keep one on purpose: add slop-ok in a comment on that line. Turn a tell off: "off" in .slophook.json.'));
  if (!process.stdin.isTTY || process.env.SLOP_HOOK_AGENT_NOTE === '1') {
    // Hooks run without a terminal when an AI agent or a GUI makes the commit.
    lines.push('  NOTE FOR AI AGENTS: tell the user about these tells in your reply, listing file:line.');
    lines.push('  Do not fix them, add slop-ok, or use --no-verify unless the user asks you to.');
  }
  console.error(lines.join('\n'));
}

// ---------- main ----------

function main() {
  let root;
  try {
    root = git(['rev-parse', '--show-toplevel']).trim();
  } catch (e) {
    console.error('slop-hook: not inside a git repository.');
    process.exit(0);
  }
  process.chdir(root);
  const cfg = loadConfig(root);
  const rules = loadRules();
  const lines = args.has('--all') ? allTracked() : stagedAdditions();
  const findings = scan(lines, rules, cfg);

  if (args.has('--json')) {
    console.log(JSON.stringify({ mode: cfg.mode, count: findings.length, findings: findings.map(({ text, ctx, ...f }) => f) }, null, 2));
    process.exit(0);
  }
  if (!findings.length) process.exit(0);
  report(findings, cfg, cfg.mode);
  if (args.has('--all')) process.exit(0);
  if (cfg.mode === 'block') process.exit(1);
  if (cfg.mode === 'ask') process.exit(20);
  process.exit(0);
}

try {
  main();
} catch (e) {
  // Never break a commit because the checker itself failed.
  console.error(`slop-hook: skipped (${e.message})`);
  process.exit(0);
}
