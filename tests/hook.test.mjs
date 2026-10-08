// Tests slop-hook in throwaway git repos.   node tests/hook.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'hook', 'install.mjs');
const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'slop-hook-'));
let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '\n      ' + String(detail).replace(/\n/g, '\n      ') : ''}`);
}

function run(cwd, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env }, input: '' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function repo(name) {
  const d = path.join(base, name);
  fs.mkdirSync(d, { recursive: true });
  run(d, 'git', ['init', '-q', '-b', 'main']);
  run(d, 'git', ['config', 'user.name', 'Test']);
  run(d, 'git', ['config', 'user.email', 'test@example.invalid']);
  run(d, 'git', ['config', 'core.autocrlf', 'false']);
  return d;
}

const write = (d, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
  fs.writeFileSync(path.join(d, rel), text);
};
const commit = (d, msg, env) => {
  run(d, 'git', ['add', '-A']);
  return run(d, 'git', ['commit', '-m', msg], env);
};
const install = (d, ...args) => run(d, process.execPath, [INSTALL, ...args]);

// ---------- 1. default warn mode ----------
{
  const d = repo('warn');
  const i = install(d);
  check('install prints success', i.code === 0 && /installed/.test(i.out), i.out);
  check('hook files copied', ['slop-hook.mjs', 'run.sh', 'rules.js'].every((f) => fs.existsSync(path.join(d, '.git', 'slop-hook', f))));

  write(d, 'index.html', `<!doctype html>
<html><head><title>Nexora</title>
<script src="https://cdn.gpteng.co/gptengineer.js" type="module"></script></head>
<body>
<h2>Why Choose Us?</h2>
<p>Fast, simple \u2014 and built for teams.</p>
<p>Our seamless platform helps you elevate your work.</p>
<p>We use an em dash here \u2014 on purpose. <!-- slop-ok --></p>
<p>Fast. Secure. Reliable.</p>
</body></html>
`);
  write(d, 'src/Hero.jsx', `import { motion } from "framer-motion";
// a comment with an em dash \u2014 should be ignored
export default function Hero() {
  return (
    <section className="flex items-center justify-between gap-4 px-6">
      <h1 className="text-4xl font-bold">Unlock your potential</h1>
      <p>{t("It's not just a tool, it's a whole new way to work.")}</p>
    </section>
  );
}
`);
  write(d, 'package-lock.json', '{"name": "seamless \u2014 robust"}\n');
  const c = commit(d, 'first');
  const log = run(d, 'git', ['log', '--oneline']).out;
  check('warn mode: commit goes through', c.code === 0 && /first/.test(log), c.out);
  check('warn mode: summary line', /slop-hook: \d+ AI tells? in 2 files \(commit continues\)/.test(c.out), c.out);
  check('flags em dash with file:line', /index\.html:6\s+em dash/.test(c.out), c.out);
  check('flags stock phrases', /index\.html:7\s+stock phrase\s+"[^"]*seamless/.test(c.out) && /index\.html:7\s+stock phrase\s+"[^"]*elevate/.test(c.out), c.out);
  check('flags generic heading', /index\.html:5\s+generic heading/.test(c.out), c.out);
  check('flags fragment list', /index\.html:9\s+fragments/.test(c.out), c.out);
  check('flags builder script', /index\.html:3\s+builder trace/.test(c.out), c.out);
  check('flags JSX text', /Hero\.jsx:6\s+stock phrase\s+"[^"]*Unlock/.test(c.out), c.out);
  check('flags not-just in a JS string', /Hero\.jsx:7\s+not just X/.test(c.out), c.out);
  check('skips slop-ok line', !/index\.html:8/.test(c.out), c.out);
  check('skips code comments', !/Hero\.jsx:2/.test(c.out), c.out);
  check('skips class names', !/Hero\.jsx:5/.test(c.out), c.out);
  check('skips lockfiles', !/package-lock\.json:\d/.test(c.out), c.out);
  check('prints note for AI agents when no terminal', /NOTE FOR AI AGENTS/.test(c.out), c.out);

  // only new lines are checked
  write(d, 'index.html', fs.readFileSync(path.join(d, 'index.html'), 'utf8').replace('</body>', '<p>Opening hours: 9 to 5.</p>\n</body>'));
  const c2 = commit(d, 'second');
  check('unchanged lines are not re-flagged', c2.code === 0 && !/slop-hook:/.test(c2.out), c2.out);

  const all = run(d, process.execPath, [path.join(d, '.git', 'slop-hook', 'slop-hook.mjs'), '--all', '--json']);
  let json = null;
  try {
    json = JSON.parse(all.out);
  } catch (e) {
    /* reported below */
  }
  check('--all --json reports the whole repo', json && json.count >= 8 && json.findings.every((f) => f.file && f.line && f.id), all.out.slice(0, 400));

  // config: turn em dashes off, ignore a folder
  write(d, '.slophook.json', JSON.stringify({ off: ['em-dash'], ignore: ['legal/**'] }));
  write(d, 'about.md', '# About\n\nWe bake bread \u2014 every day.\n');
  write(d, 'legal/terms.md', 'These terms are robust and seamless.\n');
  const c3 = commit(d, 'third');
  check('config "off" silences a tell', !/about\.md:\d/.test(c3.out), c3.out);
  check('config "ignore" skips paths', !/legal\/terms\.md:\d/.test(c3.out), c3.out);
}

// ---------- 2. block and ask modes ----------
{
  const d = repo('strict');
  const i = install(d, '--mode', 'block');
  check('--mode block saved', JSON.parse(fs.readFileSync(path.join(d, '.slophook.json'), 'utf8')).mode === 'block', i.out);
  write(d, 'a.md', 'A seamless experience.\n');
  const c = commit(d, 'blocked');
  check('block mode stops the commit', c.code !== 0 && /commit stopped/.test(c.out), c.out);
  const nv = run(d, 'git', ['commit', '--no-verify', '-m', 'forced']);
  check('--no-verify still works', nv.code === 0, nv.out);

  write(d, '.slophook.json', JSON.stringify({ mode: 'ask' }));
  write(d, 'b.md', 'Elevate your mornings.\n');
  const a = commit(d, 'asked');
  check('ask mode without a terminal lets the commit through', a.code === 0 && /no terminal to ask/.test(a.out), a.out);

  const e = commit(d, 'env', { SLOP_HOOK_MODE: 'warn' });
  check('SLOP_HOOK_MODE overrides config', e.code === 0 || /nothing to commit/.test(e.out), e.out);
}

// ---------- 3. existing hook is kept ----------
{
  const d = repo('existing');
  write(d, '.git/hooks/pre-commit', '#!/bin/sh\necho "other hook ran"\nexit 0\n');
  install(d);
  install(d); // twice: still one block
  const hook = fs.readFileSync(path.join(d, '.git', 'hooks', 'pre-commit'), 'utf8');
  check('existing hook kept', /other hook ran/.test(hook), hook);
  check('our line runs before an existing exit 0', hook.indexOf('slop-hook') < hook.indexOf('exit 0'), hook);
  check('reinstall does not duplicate', hook.split('>>> slop-hook >>>').length === 2, hook);
  write(d, 'x.md', 'Leverage synergy.\n');
  const c = commit(d, 'both');
  check('both hooks run', /slop-hook:/.test(c.out) && /other hook ran/.test(c.out) && c.code === 0, c.out);
}

// ---------- 4. agent notes ----------
{
  const d = repo('agents');
  const i = install(d, '--agents');
  const agents = path.join(d, 'AGENTS.md');
  check('--agents creates AGENTS.md when none exist', fs.existsSync(agents) && /slop-hook:start/.test(fs.readFileSync(agents, 'utf8')), i.out);
  check('suggests CLAUDE.md for Claude Code', /CLAUDE\.md/.test(i.out), i.out);

  write(d, 'CLAUDE.md', '# Project rules\r\n\r\nUse pnpm.\r\n');
  install(d, '--agents');
  install(d, '--agents');
  const claude = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8');
  const agentsTxt = fs.readFileSync(agents, 'utf8');
  check('existing CLAUDE.md gets the note, content kept', /Use pnpm\./.test(claude) && /slop-hook:start/.test(claude), claude);
  check('CRLF line endings kept', /\r\n/.test(claude) && !/[^\r]\n/.test(claude), JSON.stringify(claude.slice(0, 120)));
  check('note is not duplicated', claude.split('slop-hook:start').length === 2 && agentsTxt.split('slop-hook:start').length === 2);
  check('note tells agents to report, not fix', /tell the user in your reply/.test(agentsTxt) && /Don't fix them/.test(agentsTxt));

  write(d, 'page.md', 'Our robust platform.\n');
  const c = commit(d, 'with agent files');
  check('agent files themselves are not scanned', c.code === 0 && !/(AGENTS|CLAUDE)\.md:\d/.test(c.out) && /page\.md:1/.test(c.out), c.out);

  const u = install(d, '--uninstall');
  check('uninstall removes hook and tool dir', !fs.existsSync(path.join(d, '.git', 'hooks', 'pre-commit')) && !fs.existsSync(path.join(d, '.git', 'slop-hook')), u.out);
  check('uninstall removes notes, keeps the rest', !fs.existsSync(agents) && /Use pnpm\./.test(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8')) && !/slop-hook/.test(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8')), u.out);
  write(d, 'page2.md', 'Seamless again.\n');
  const c2 = commit(d, 'after uninstall');
  check('no checks after uninstall', c2.code === 0 && !/slop-hook:/.test(c2.out), c2.out);
}

// ---------- 5. husky ----------
{
  const d = repo('husky');
  write(d, '.husky/pre-commit', 'npm test\n');
  fs.mkdirSync(path.join(d, '.husky', '_'), { recursive: true });
  run(d, 'git', ['config', 'core.hooksPath', '.husky/_']);
  install(d);
  const h = fs.readFileSync(path.join(d, '.husky', 'pre-commit'), 'utf8');
  check('husky: line added to .husky/pre-commit, npm test kept', /slop-hook/.test(h) && /npm test/.test(h), h);
}

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
