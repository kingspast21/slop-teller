// Builds the Markdown fix list handed to a developer's AI assistant.
(() => {
  if (globalThis.SlopExport) return;

  const LAYER_ORDER = ['fingerprints', 'copy', 'design'];
  const LAYER_TITLE = {
    fingerprints: 'Builder fingerprints (remove these first)',
    copy: 'Copy tells',
    design: 'Design tells (suggestions, not orders)',
  };
  const MAX_ITEMS_PER_TELL = 40;

  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const code = (s) => {
    const t = String(s == null ? '' : s).replace(/\r?\n/g, ' ');
    const ticks = t.includes('`') ? '``' : '`';
    return `${ticks}${ticks.length > 1 ? ' ' : ''}${t}${ticks.length > 1 ? ' ' : ''}${ticks}`;
  };

  function build(report, scoreInfo, opts) {
    const kept = opts.kept || new Set();
    const only = opts.only || null; // Set of finding ids, or null for all
    const live = report.findings.filter((f) => !kept.has(f.id) && (!only || only.has(f.id)));
    const keptFindings = report.findings.filter((f) => kept.has(f.id));
    const L = [];

    L.push(`# AI tell fix list: ${report.title || report.url}`);
    L.push('');
    L.push(`- Page: ${report.url}`);
    L.push(`- Scanned: ${report.scannedAt.replace('T', ' ').slice(0, 16)} UTC by Slop Teller`);
    L.push(
      `- Score: **${scoreInfo.total}/100 (${scoreInfo.band})**. Fingerprints ${scoreInfo.layers.fingerprints}/${scoreInfo.limits.fingerprints}, copy ${scoreInfo.layers.copy}/${scoreInfo.limits.copy}, design ${scoreInfo.layers.design}/${scoreInfo.limits.design}.`
    );
    if (only) L.push(`- Scope: ${live.length} selected tell${live.length === 1 ? '' : 's'} only.`);
    L.push('');

    L.push('## Instructions for the assistant');
    L.push('');
    L.push('You are cleaning up a website so it no longer reads as AI-generated. The findings below come from a scan of the rendered page, not the source code.');
    L.push('');
    L.push('1. Locate each item in the repository by searching for the quoted text. Use the CSS selector as a hint for which component renders it. Copy may live in components, data/content files, CMS exports or metadata.');
    L.push('2. Apply the fix described for each tell. Rewrite in context; never do a blind find-and-replace across the codebase.');
    L.push('3. Keep the meaning, facts, product names and the brand\'s voice. Don\'t invent claims, numbers or testimonials.');
    L.push('4. Don\'t introduce new tells while fixing: no em dashes, no stock phrases from the list below, no "not just X, it\'s Y", no new gradients or emoji.');
    L.push('5. Leave everything in "Keep as is" untouched.');
    L.push('6. Design items are suggestions. If a change would alter the layout or brand, list it for the developer instead of applying it.');
    L.push('7. Finish with a short summary: what you changed (file and line), and anything you could not find or chose to skip.');
    L.push('');

    if (!live.length) {
      L.push('## Findings');
      L.push('');
      L.push('No tells in scope.');
      L.push('');
    }

    let n = 0;
    for (const layer of LAYER_ORDER) {
      const group = live.filter((f) => f.layer === layer).sort((a, b) => b.points - a.points);
      if (!group.length) continue;
      L.push(`## ${LAYER_TITLE[layer]}`);
      L.push('');
      for (const f of group) {
        n++;
        L.push(`### ${n}. ${f.label} (${f.occurrences.length} found)`);
        L.push('');
        L.push(`**Why it reads as AI:** ${f.why}`);
        L.push('');
        L.push(`**How to fix:** ${f.fix}`);
        L.push('');
        const shown = f.occurrences.slice(0, MAX_ITEMS_PER_TELL);
        if (layer === 'copy') {
          L.push('| # | Match | In context | Selector |');
          L.push('|---|---|---|---|');
          shown.forEach((o, i) => {
            L.push(`| ${i + 1} | ${esc(code(o.match))} | ${esc(o.snippet)} | ${esc(code(o.selector))} |`);
          });
        } else {
          shown.forEach((o, i) => {
            L.push(`${i + 1}. ${o.snippet}${o.selector ? ` (selector ${code(o.selector)})` : ''}`);
          });
        }
        if (f.occurrences.length > shown.length) {
          L.push('');
          L.push(`...and ${f.occurrences.length - shown.length} more. Search the codebase for the same pattern.`);
        }
        L.push('');
      }
    }

    L.push('## Keep as is');
    L.push('');
    if (keptFindings.length) {
      L.push('The developer marked these as intentional. Do not change them:');
      L.push('');
      keptFindings.forEach((f) => L.push(`- ${f.label} (${f.occurrences.length} on this page)`));
    } else {
      L.push('Nothing marked. If something listed above is a deliberate brand choice, skip it and say so in your summary.');
    }
    L.push('');

    if (report.unread.length) {
      L.push('## Not scanned');
      L.push('');
      L.push(`The scan could not read inside: ${report.unread.join(', ')}. Check those parts by hand.`);
      L.push('');
    }

    L.push('---');
    L.push('A score counts tells, not proof. Plenty of people write em dashes and choose gradients on purpose.');
    L.push('');
    return L.join('\n');
  }

  function filename(report) {
    let host = 'page';
    try {
      const u = new URL(report.url);
      host = (u.hostname || 'local') + (u.pathname !== '/' ? u.pathname : '');
    } catch (e) {
      /* keep default */
    }
    const slug = host.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60).toLowerCase() || 'page';
    return `slop-report-${slug}.md`;
  }

  function download(md, name) {
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  globalThis.SlopExport = { build, filename, download };
})();
