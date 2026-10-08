// End-to-end test: loads the real unpacked extension into Chromium, runs it on
// pages, checks the findings and the Markdown export, and saves screenshots.
//
//   node tests/run.mjs [extra URLs...]
//
// The test copy of the manifest adds <all_urls> so the service worker can inject
// without a real toolbar click (activeTab needs a user gesture). The shipped
// manifest is untouched.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'out');
fs.mkdirSync(OUT, { recursive: true });

// --- test copy of the extension ---
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'slop-ext-'));
for (const p of ['manifest.json', 'src', 'icons']) fs.cpSync(path.join(ROOT, p), path.join(tmp, p), { recursive: true });
const man = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
man.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(man, null, 2));

// --- fixture server ---
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, 'tests', 'fixtures', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f));
  } else {
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// Reuse an already-installed Playwright Chromium if the matching one isn't there.
function findChromium() {
  if (process.env.SLOP_CHROME) return process.env.SLOP_CHROME;
  const dir = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(dir)) return undefined;
  const builds = fs.readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const b of builds) {
    const exe = path.join(dir, b, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  executablePath: findChromium(),
  headless: true,
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
  args: [`--disable-extensions-except=${tmp}`, `--load-extension=${tmp}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');

const errors = [];
async function scanPage(url, name) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(1200);
  // "click" the toolbar icon
  await sw.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u.split('#')[0] + '*' });
    await run(tab);
  }, page.url());
  // the panel lives in the page's main world? No: content scripts run in an isolated
  // world, so read results through the DOM and the exported Markdown.
  await page.waitForSelector('slop-teller-root', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(500);
  const ui = await page.evaluate(() => {
    const root = document.querySelector('slop-teller-root').shadowRoot;
    const t = (s) => (root.querySelector(s) || {}).textContent || '';
    return {
      score: t('.score-num').trim(),
      band: t('.band').trim(),
      sub: t('.sub').trim(),
      layers: [...root.querySelectorAll('.layer')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()),
      tells: [...root.querySelectorAll('.tell')].map((li) => ({
        id: li.dataset.id,
        name: li.querySelector('.tname').textContent,
        count: +(li.querySelector('.pos') ? li.querySelector('.pos').textContent.split('/')[1] : li.querySelector('.stepper').textContent) || 0,
        stepper: li.querySelector('.stepper').textContent.replace(/\s+/g, ' ').trim(),
        pts: li.querySelector('.tpts').textContent,
      })),
      boxes: root.querySelectorAll('.box').length,
      copyMarksOnScreen: [...root.querySelectorAll('.hl')].filter((n) => n.style.display !== 'none').length,
      tagOverlaps: (() => {
        const tags = [...root.querySelectorAll('.box')].filter((b) => b.style.display !== 'none').map((b) => b.querySelector('.tag').getBoundingClientRect());
        let n = 0;
        for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
          const a = tags[i], c = tags[j];
          if (a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom) n++;
        }
        return n;
      })(),
      unread: t('.unread'),
    };
  });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });

  // Export through the real button and capture the download.
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.evaluate(() => document.querySelector('slop-teller-root').shadowRoot.querySelector('[data-act="export"]').click()),
  ]);
  const mdPath = path.join(OUT, `${name}.md`);
  await dl.saveAs(mdPath);
  ui.mdName = dl.suggestedFilename();
  ui.mdBytes = fs.statSync(mdPath).size;
  return { page, ui };
}

const results = {};
const targets = [
  [`${base}/sloppy.html`, 'sloppy'],
  [`${base}/clean.html`, 'clean'],
  ...process.argv.slice(2).map((u, i) => [u, 'site' + (i + 1) + '-' + new URL(u).hostname.replace(/\W+/g, '-')]),
];

for (const [url, name] of targets) {
  try {
    const { page, ui } = await scanPage(url, name);
    results[name] = ui;

    if (name === 'sloppy') {
      const root = 'document.querySelector("slop-teller-root").shadowRoot';
      // open a tell, jump to it, hover a mark, keep a tell, selected-only export
      await page.evaluate(`${root}.querySelector('[data-act="toggle"][data-id="em-dash"]').click()`);
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(OUT, 'sloppy-open.png') });
      const box = await page.evaluate(() => {
        const h = document.querySelector('.pill').getBoundingClientRect();
        return { x: h.left + h.width / 2, y: h.top + h.height / 2 };
      });
      await page.mouse.move(box.x, box.y);
      await page.waitForTimeout(250);
      results.sloppy.hoverNote = await page.evaluate(`${root}.querySelector('.note').hidden ? null : ${root}.querySelector('.note').textContent`);
      // hover a copy mark (the word "seamless" in the list further down is offscreen; use the hero subtext)
      const word = await page.evaluate(() => {
        const p = document.querySelector('.hero p');
        const t = p.firstChild; const i = t.nodeValue.indexOf('Unlock');
        const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 6);
        const q = r.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 };
      });
      await page.mouse.move(word.x, word.y);
      await page.waitForTimeout(250);
      results.sloppy.hoverCopyNote = await page.evaluate(`${root}.querySelector('.note').hidden ? null : ${root}.querySelector('.note b').textContent`);
      await page.screenshot({ path: path.join(OUT, 'sloppy-hover.png') });

      // --- stepping: click the tell name, then next/prev, check counter, scroll and current mark
      const R = (sel) => `${root}.querySelector('${sel}')`;
      const stepInfo = async () => page.evaluate(`(() => {
        const r = ${root};
        const li = r.querySelector('.tell[data-id="stock-phrases"]');
        const pin = r.querySelector('.pin');
        const cur = r.querySelector('.hl.current');
        return {
          pos: li.querySelector('.pos').textContent.trim(),
          active: li.classList.contains('active'),
          pin: pin && pin.style.display !== 'none' ? pin.textContent.trim() : null,
          curMarks: r.querySelectorAll('.hl.current').length,
          curOnScreen: cur ? (() => { const b = cur.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; })() : false,
          scrollY: Math.round(scrollY),
        };
      })()`);
      const steps = [];
      await page.evaluate(`${R('.tell-main[data-id="stock-phrases"]')}.click()`); await page.waitForTimeout(700); steps.push(await stepInfo());
      await page.evaluate(`${R('.stepper[data-id="stock-phrases"] [data-dir="1"]')}.click()`); await page.waitForTimeout(700); steps.push(await stepInfo());
      for (let k = 0; k < 15; k++) await page.evaluate(`${R('.stepper[data-id="stock-phrases"] [data-dir="1"]')}.click()`);
      await page.waitForTimeout(900); steps.push(await stepInfo());
      await page.screenshot({ path: path.join(OUT, 'sloppy-step.png') });
      for (let k = 0; k < 4; k++) await page.evaluate(`${R('.stepper[data-id="stock-phrases"] [data-dir="1"]')}.click()`); // 17 -> 20 -> wraps to 1
      await page.waitForTimeout(700); steps.push(await stepInfo());
      await page.evaluate(`${R('.stepper[data-id="stock-phrases"] [data-dir="-1"]')}.click()`); await page.waitForTimeout(700); steps.push(await stepInfo());
      await page.keyboard.press('Alt+ArrowUp'); await page.waitForTimeout(700); steps.push(await stepInfo());
      results.sloppy.steps = steps;
      // design tell (element boxes): step the icon cards / glass cards
      await page.evaluate(`${R('.tell-main[data-id="glass-cards"]')}.click()`); await page.waitForTimeout(700);
      await page.evaluate(`${R('.stepper[data-id="glass-cards"] [data-dir="1"]')}.click()`); await page.waitForTimeout(700);
      results.sloppy.glassStep = await page.evaluate(`({ pos: ${R('.tell[data-id="glass-cards"] .pos')}.textContent.trim(), boxCurrent: ${root}.querySelectorAll('.box.current').length, pin: ${R('.pin')}.textContent.trim(), stockActive: ${R('.tell[data-id="stock-phrases"]')}.classList.contains('active') })`);
      await page.screenshot({ path: path.join(OUT, 'sloppy-step-design.png') });
      // source-only tell: click opens details instead of jumping
      await page.evaluate(`${R('.tell-main[data-id="builder-attrs"]')}.click()`); await page.waitForTimeout(300);
      results.sloppy.sourceOnlyOpens = await page.evaluate(`${R('.tell[data-id="builder-attrs"]')}.classList.contains('open')`);
      await page.evaluate('scrollTo(0,0)'); await page.waitForTimeout(300);

      const before = await page.evaluate(`${root}.querySelector('.score-num').textContent`);
      await page.evaluate(`${root}.querySelector('[data-act="keep"][data-id="em-dash"]').click()`);
      await page.waitForTimeout(150);
      const after = await page.evaluate(`${root}.querySelector('.score-num').textContent`);
      results.sloppy.keepEmDash = { before, after };

      await page.evaluate(`${root}.querySelector('[data-act="pick"][data-id="stock-phrases"]').click()`);
      await page.evaluate(`${root}.querySelector('[data-act="pick"][data-id="builder-trace"]').click()`);
      const [dl2] = await Promise.all([
        page.waitForEvent('download'),
        page.evaluate(`${root}.querySelector('[data-act="export"]').click()`),
      ]);
      await dl2.saveAs(path.join(OUT, 'sloppy-selected.md'));

      // scroll: boxes must follow
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(300);
      results.sloppy.noteHiddenAfterScroll = await page.evaluate(`${root}.querySelector('.note').hidden`);
      results.sloppy.copyMarksAfterScroll = await page.evaluate(`[...${root}.querySelectorAll('.hl')].filter((n) => n.style.display !== 'none').length`);
      // marks must sit on their text: compare first visible mark with its range
      results.sloppy.markAlignment = await page.evaluate(() => {
        const root = document.querySelector('slop-teller-root').shadowRoot;
        const n = [...root.querySelectorAll('.hl')].find((x) => x.style.display !== 'none');
        if (!n) return null;
        const a = n.getBoundingClientRect();
        const el = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
        return { mark: [Math.round(a.left), Math.round(a.top), Math.round(a.width)], under: el && el.tagName };
      });
      await page.screenshot({ path: path.join(OUT, 'sloppy-scrolled.png') });

      // toggle closed and open again through the toolbar path
      await sw.evaluate(async (u) => { const [tab] = await chrome.tabs.query({ url: u + '*' }); await run(tab); }, page.url());
      results.sloppy.closedHidden = await page.evaluate(() => getComputedStyle(document.querySelector('slop-teller-root')).display === 'none');
      await sw.evaluate(async (u) => { const [tab] = await chrome.tabs.query({ url: u + '*' }); await run(tab); }, page.url());
      await page.waitForTimeout(300);
      results.sloppy.reopenedScore = await page.evaluate(`${root}.querySelector('.score-num').textContent`);
      results.sloppy.reopenedKeptPersisted = await page.evaluate(`!!${root}.querySelector('.tell.kept[data-id="em-dash"]')`);

      // phone width
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, 'sloppy-phone.png') });
      results.sloppy.phonePanelWidth = await page.evaluate(`${root}.querySelector('.panel').getBoundingClientRect().width`);
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.close();
  } catch (e) {
    results[name] = { error: String(e && e.message || e).slice(0, 400) };
  }
}

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, errors }, null, 2));
console.log(JSON.stringify({ results, errors }, null, 2));
await ctx.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
