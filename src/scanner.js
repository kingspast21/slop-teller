// Slop Teller scanner: reads the rendered page and returns findings.
// Pure DOM work, no network, no page modifications.
(() => {
  if (globalThis.SlopScanner) return;

  const HOST_TAG = 'slop-teller-root';
  const SKIP_SELECTOR = 'script,style,noscript,template,textarea,code,pre,svg,kbd,samp,' + HOST_TAG;
  const MAX_OCCURRENCES = 200;
  const MAX_ELEMENTS = 8000;

  function makeCtx() {
    const cache = new WeakMap();
    return {
      cs(el) {
        let s = cache.get(el);
        if (!s) {
          s = getComputedStyle(el);
          cache.set(el, s);
        }
        return s;
      },
    };
  }

  function isVisible(el, ctx) {
    if (!el || !el.getClientRects().length) return false;
    return ctx.cs(el).visibility !== 'hidden';
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < 5) {
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
        parts.unshift('#' + cur.id);
        break;
      }
      let part = cur.tagName.toLowerCase();
      const cls = [...cur.classList].filter((c) => /^[A-Za-z_-][\w-]*$/.test(c) && c.length < 32).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (cur === document.body) break;
      cur = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  function clip(text, max = 90) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 3) + '...' : t;
  }

  function snippet(text, start, end, pad = 45) {
    const a = Math.max(0, start - pad);
    const b = Math.min(text.length, end + pad);
    return (a > 0 ? '...' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? '...' : '');
  }

  // ---------- text collection ----------

  function blockOf(node, ctx) {
    let el = node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const d = ctx.cs(el).display;
      if (d !== 'inline' && d !== 'contents') return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function collectBlocks(ctx) {
    const blocks = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || p.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const b = blockOf(n, ctx);
      let entry = blocks.get(b);
      if (!entry) {
        entry = { el: b, text: '', segs: [] };
        blocks.set(b, entry);
      }
      const start = entry.text.length;
      entry.text += n.nodeValue;
      entry.segs.push({ node: n, start, end: entry.text.length });
    }
    return [...blocks.values()].filter((b) => isVisible(b.el, ctx));
  }

  function rangeFor(entry, s, e) {
    const r = document.createRange();
    let started = false;
    for (const g of entry.segs) {
      if (!started && s >= g.start && s < g.end) {
        r.setStart(g.node, s - g.start);
        started = true;
      }
      if (started && e > g.start && e <= g.end) {
        r.setEnd(g.node, e - g.start);
        return r;
      }
    }
    return null;
  }

  // ---------- copy ----------

  function scanCopy(R, blocks) {
    const findings = [];
    for (const rule of R.copy) {
      const flags = rule.flags || '';
      const baseFlags = flags.includes('i') ? flags : flags + 'i';
      const occ = [];
      for (const b of blocks) {
        if (occ.length >= MAX_OCCURRENCES) break;
        const tag = b.el.tagName;
        if (rule.scope === 'heading' && !/^H[1-3]$/.test(tag)) continue;
        if (rule.scope === 'body' && /^H[1-6]$/.test(tag)) continue;
        if (rule.scope === 'whole') {
          const t = b.text.trim();
          if (t.length > 120 || !new RegExp(rule.pattern, baseFlags).test(t)) continue;
          const s = b.text.indexOf(t);
          const r = rangeFor(b, s, s + t.length);
          if (r) occ.push({ kind: 'range', range: r, el: b.el, match: t, snippet: clip(t), selector: cssPath(b.el) });
          continue;
        }
        const re = new RegExp(rule.pattern, baseFlags + 'g');
        let m;
        while ((m = re.exec(b.text))) {
          if (!m[0].length) {
            re.lastIndex++;
            continue;
          }
          const r = rangeFor(b, m.index, m.index + m[0].length);
          if (r) {
            occ.push({
              kind: 'range',
              range: r,
              el: b.el,
              match: m[0].trim() || m[0],
              snippet: snippet(b.text, m.index, m.index + m[0].length),
              selector: cssPath(b.el),
            });
          }
          if (occ.length >= MAX_OCCURRENCES) break;
        }
      }
      if (occ.length) {
        findings.push({
          id: rule.id,
          layer: 'copy',
          label: rule.label,
          short: rule.short,
          why: rule.why,
          fix: rule.fix,
          weight: rule.weight,
          occurrences: occ,
          points: Math.min(rule.cap, occ.length * rule.weight),
        });
      }
    }
    return findings;
  }

  // ---------- fingerprints ----------

  function scanFingerprints(R) {
    const F = R.fingerprints;
    const re = new RegExp(F.builderPattern, 'i');
    const badgeRe = new RegExp(F.badgeText, 'i');
    const traces = [];
    const seen = new Set();
    const matchedEls = new Set();
    // The page's own hostname is reported once (below), so strip it before
    // testing URLs; otherwise every canonical/og:url/analytics URL repeats it.
    const ownHost = location.hostname.toLowerCase();
    const urlHit = (v) => re.test(ownHost ? v.toLowerCase().split(ownHost).join('') : v);
    const add = (el, where, value) => {
      const key = where + '|' + value;
      if (seen.has(key)) return;
      seen.add(key);
      traces.push({ kind: el && el.isConnected && el.getClientRects().length ? 'el' : 'source', el, match: clip(value, 120), snippet: `${where}: ${clip(value, 120)}`, selector: cssPath(el) });
    };

    document.querySelectorAll('script[src],link[href],iframe[src],img[src],source[src]').forEach((el) => {
      const v = el.getAttribute('src') || el.getAttribute('href') || '';
      if (urlHit(v)) add(el, `<${el.tagName.toLowerCase()}> ${el.hasAttribute('src') ? 'src' : 'href'}`, v);
    });
    document.querySelectorAll('meta[content]').forEach((el) => {
      const v = el.getAttribute('content') || '';
      if (urlHit(v)) add(el, `<meta ${el.getAttribute('name') || el.getAttribute('property') || ''}>`, v);
    });
    document.querySelectorAll('a[href]').forEach((el) => {
      const v = el.getAttribute('href') || '';
      const text = el.textContent || '';
      if (urlHit(v) && (badgeRe.test(text) || re.test(el.id + ' ' + el.className))) {
        matchedEls.add(el);
        add(el, 'badge link', `${clip(text, 40)} -> ${v}`);
      }
    });
    document.querySelectorAll('[id],[class]').forEach((el) => {
      if (el.closest(HOST_TAG)) return;
      const cls = typeof el.className === 'string' ? el.className : '';
      const v = `${el.id} ${cls}`;
      if (!re.test(v)) return;
      // one entry per badge: skip parts of an element that already matched,
      // and let a matching wrapper cover its other children too
      let covered = false;
      for (const m of matchedEls) {
        if (m.contains(el)) return;
        if (el.contains(m)) covered = true;
      }
      matchedEls.add(el);
      if (covered) return;
      add(el, 'element id/class', `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ${clip(cls, 60)}`);
    });
    // Inline scripts are not checked: sites often mention builders in nav or
    // link data (vercel.com links to v0), which is not a fingerprint.

    if (F.builderHosts && new RegExp(F.builderHosts, 'i').test(ownHost)) {
      traces.unshift({ kind: 'source', el: null, match: ownHost, snippet: `hosted on ${ownHost}, a builder's default domain`, selector: '' });
    }

    const findings = [];
    const meta = F.rules;
    const mk = (id, occ, points) => ({
      id,
      layer: 'fingerprints',
      label: meta[id].label,
      short: meta[id].short,
      why: meta[id].why,
      fix: meta[id].fix,
      weight: meta[id].weight,
      occurrences: occ,
      points,
    });
    if (traces.length) {
      findings.push(mk('builder-trace', traces, Math.min(meta['builder-trace'].cap, traces.length * meta['builder-trace'].weight)));
    }

    const attrSel = F.builderAttrs.map((a) => `[${a}]`).join(',');
    const attrEls = [...document.querySelectorAll(attrSel)].filter((el) => !el.closest(HOST_TAG));
    if (attrEls.length) {
      const attrs = F.builderAttrs.filter((a) => document.querySelector(`[${a}]`));
      const occ = attrEls.slice(0, 5).map((el) => ({
        kind: 'source', // an HTML attribute, not something to outline on screen
        el,
        match: attrs.join(', '),
        snippet: `${attrEls.length} elements carry ${attrs.join(', ')}, e.g. <${el.tagName.toLowerCase()} ${attrs[0]}="${clip(el.getAttribute(attrs[0]) || '', 50)}">`,
        selector: cssPath(el),
      }));
      findings.push(mk('builder-attrs', occ, meta['builder-attrs'].cap));
    }

    const leftovers = [];
    const title = (document.title || '').trim().toLowerCase();
    if (F.starterTitles.includes(title)) leftovers.push({ kind: 'source', el: document.querySelector('title'), match: document.title, snippet: `<title>${document.title}</title>`, selector: 'head > title' });
    const desc = document.querySelector('meta[name="description"]');
    const dv = desc ? (desc.getAttribute('content') || '').trim().toLowerCase() : '';
    if (dv && F.starterDescriptions.some((d) => dv.includes(d))) leftovers.push({ kind: 'source', el: desc, match: dv, snippet: `<meta name="description" content="${clip(desc.getAttribute('content'), 80)}">`, selector: 'meta[name="description"]' });
    document.querySelectorAll('link[rel~="icon"][href], img[src]').forEach((el) => {
      const v = el.getAttribute('href') || el.getAttribute('src') || '';
      const clean = v.split('?')[0].toLowerCase();
      if (F.starterFiles.some((f) => clean.endsWith(f))) {
        leftovers.push({ kind: el.tagName === 'IMG' && el.getClientRects().length ? 'el' : 'source', el, match: v, snippet: `<${el.tagName.toLowerCase()}> ${v}`, selector: cssPath(el) });
      }
    });
    if (leftovers.length) {
      findings.push(mk('starter-leftovers', leftovers, Math.min(meta['starter-leftovers'].cap, leftovers.length * meta['starter-leftovers'].weight)));
    }
    return findings;
  }

  // ---------- design ----------

  function parseColors(str) {
    const out = [];
    const re = /rgba?\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(str))) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      if (p.length >= 3 && (p.length < 4 || p[3] > 0.15)) out.push(p.slice(0, 3));
    }
    return out;
  }

  function hsl([r, g, b]) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }

  const isPurple = (c) => {
    const [h, s, l] = hsl(c);
    return h >= 245 && h <= 320 && s > 0.35 && l > 0.2 && l < 0.85;
  };

  function hasPaint(s) {
    const bg = s.backgroundColor;
    const transparentBg = !bg || bg === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(bg);
    const border = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none';
    return !transparentBg || border || (s.backgroundImage && s.backgroundImage !== 'none');
  }

  function inChrome(el) {
    return Boolean(el.closest('nav, header[role="banner"], footer, [role="navigation"]'));
  }

  function scanDesign(R, ctx, els) {
    const D = R.design;
    const hits = {};
    const push = (id, el, desc) => {
      (hits[id] = hits[id] || []).push({ kind: 'el', el, match: desc, snippet: desc, selector: cssPath(el) });
    };

    const gradientTextEls = new Set();
    for (const el of els) {
      const s = ctx.cs(el);
      const img = s.backgroundImage;
      if (img && img.includes('gradient')) {
        const clipText = s.backgroundClip === 'text' || s.webkitBackgroundClip === 'text';
        if (clipText && isVisible(el, ctx)) {
          gradientTextEls.add(el);
          push('gradient-text', el, `"${clip(el.textContent, 50)}" filled with a gradient`);
          continue;
        }
        const colors = parseColors(img);
        if (colors.some(isPurple) && isVisible(el, ctx)) {
          const r = el.getBoundingClientRect();
          if (r.width * r.height > 6000) push('purple-gradient', el, `${el.tagName.toLowerCase()} background ${clip(img, 70)}`);
        }
      }
      const bf = s.backdropFilter || s.webkitBackdropFilter || '';
      if (bf.includes('blur') && s.position !== 'fixed' && s.position !== 'sticky' && !inChrome(el)) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height > 5000 && isVisible(el, ctx)) push('glass-cards', el, `${el.tagName.toLowerCase()} with ${bf}`);
      }
    }

    // Hero: the first visible h1, or the largest heading near the top.
    let h1 = [...document.querySelectorAll('h1')].find((h) => isVisible(h, ctx) && !h.closest(HOST_TAG));
    if (h1) {
      const h1r = h1.getBoundingClientRect();
      let container = h1;
      for (let i = 0; i < 3 && container.parentElement && container.parentElement !== document.body; i++) container = container.parentElement;

      // Pill badge just above the headline.
      const before = [...container.querySelectorAll('*')].filter(
        (el) => el.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING && !el.contains(h1)
      );
      const badge = before.reverse().find((el) => {
        if (!isVisible(el, ctx)) return false;
        const r = el.getBoundingClientRect();
        const t = (el.textContent || '').trim();
        if (r.height < 16 || r.height > 46 || t.length < 2 || t.length > 70) return false;
        if (h1r.top - r.bottom < -2 || h1r.top - r.bottom > 140) return false;
        const s = ctx.cs(el);
        return parseFloat(s.borderTopLeftRadius) >= r.height / 2 - 1 && hasPaint(s);
      });
      if (badge) push('hero-badge', badge, `"${clip(badge.textContent, 50)}" pill above the headline`);

      // Centred headline followed by two or more buttons.
      const centred = ctx.cs(h1).textAlign === 'center' || Math.abs(h1r.left + h1r.width / 2 - innerWidth / 2) < 12 && h1r.width < innerWidth * 0.8;
      if (centred) {
        const after = [...container.querySelectorAll('a, button')].filter((el) => {
          if (!(h1.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || !isVisible(el, ctx)) return false;
          const s = ctx.cs(el);
          const r = el.getBoundingClientRect();
          return r.top - h1r.bottom < 400 && parseFloat(s.paddingLeft) >= 8 && hasPaint(s);
        });
        if (after.length >= 2) push('centered-hero', h1, `centred headline "${clip(h1.textContent, 50)}" with ${after.length} buttons`);
      }

      const fam = (ctx.cs(h1).fontFamily || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
      if (/^(inter|inter variable|geist|geist sans|__inter_\w+|__geist\w*)$/.test(fam) || /^__(inter|geist)/.test(fam)) {
        push('default-font', h1, `headline set in ${fam.replace(/^__|_\w+$/g, '')}`);
      }
    }

    // Rows of identical icon cards.
    const flaggedGrids = [];
    for (const el of els) {
      const kids = [...el.children];
      if (kids.length < 3 || kids.length > 6) continue;
      if (inChrome(el) || flaggedGrids.some((g) => g.contains(el))) continue;
      const sig = (k) => k.tagName + '|' + (typeof k.className === 'string' ? k.className : '');
      if (!kids.every((k) => sig(k) === sig(kids[0]))) continue;
      const ok = kids.every((k) => {
        const t = (k.textContent || '').trim();
        if (t.length < 15 || t.length > 420) return false;
        const icon = k.querySelector('svg, img, i[class]') || /^\s*\p{Extended_Pictographic}/u.test(t);
        const head = k.querySelector('h2, h3, h4, h5, strong');
        return icon && head;
      });
      if (!ok || !isVisible(el, ctx)) continue;
      const tops = kids.slice(0, 3).map((k) => Math.round(k.getBoundingClientRect().top));
      if (Math.max(...tops) - Math.min(...tops) > 6) continue;
      flaggedGrids.push(el);
      push('icon-card-grid', el, `${kids.length} identical cards: ${kids.map((k) => '"' + clip((k.querySelector('h2, h3, h4, h5, strong') || k).textContent, 24) + '"').join(', ')}`);
    }

    const findings = [];
    for (const [id, occ] of Object.entries(hits)) {
      const meta = D[id];
      findings.push({
        id,
        layer: 'design',
        label: meta.label,
        short: meta.short,
        why: meta.why,
        fix: meta.fix,
        weight: meta.weight,
        occurrences: occ.slice(0, MAX_OCCURRENCES),
        points: Math.min(meta.cap, occ.length * meta.weight),
      });
    }
    return findings;
  }

  // ---------- scoring ----------

  const LIMITS = { fingerprints: 40, copy: 35, design: 25 };

  function score(report, kept) {
    const live = report.findings.filter((f) => !kept.has(f.id));
    const raw = (layer) => live.filter((f) => f.layer === layer).reduce((a, f) => a + f.points, 0);
    const copyRaw = raw('copy');
    // Copy is scored per 1,000 words so long pages are not penalised for length.
    const copyScaled = (copyRaw * 1000) / Math.max(report.words, 400) * 0.6;
    const layers = {
      fingerprints: Math.min(LIMITS.fingerprints, raw('fingerprints')),
      copy: Math.min(LIMITS.copy, Math.round(copyScaled)),
      design: Math.min(LIMITS.design, raw('design')),
    };
    const total = Math.min(100, layers.fingerprints + layers.copy + layers.design);
    const band = total >= 70 ? 'Heavy' : total >= 40 ? 'Many tells' : total >= 15 ? 'Some tells' : 'Few tells';
    // Each finding's share of its layer score, for display.
    const contrib = {};
    for (const f of live) {
      const layerRaw = raw(f.layer);
      contrib[f.id] = layerRaw ? Math.round((layers[f.layer] * f.points) / layerRaw) : 0;
    }
    return { total, band, layers, limits: LIMITS, contrib };
  }

  function scan() {
    const t0 = performance.now();
    const R = globalThis.SlopRules;
    const ctx = makeCtx();
    const blocks = collectBlocks(ctx);
    const words = blocks.reduce((a, b) => a + (b.text.trim().match(/\S+/g) || []).length, 0);
    const els = [...document.body.querySelectorAll('*')].filter((el) => !el.closest(HOST_TAG)).slice(0, MAX_ELEMENTS);

    const findings = [...scanFingerprints(R), ...scanCopy(R, blocks), ...scanDesign(R, ctx, els)];

    const unread = [];
    const iframes = document.querySelectorAll('iframe').length;
    if (iframes) unread.push(`${iframes} iframe${iframes > 1 ? 's' : ''}`);
    const canvases = [...document.querySelectorAll('canvas')].filter((c) => c.width * c.height > 40000).length;
    if (canvases) unread.push(`${canvases} canvas${canvases > 1 ? 'es' : ''}`);
    const shadows = els.filter((el) => el.shadowRoot).length;
    if (shadows) unread.push(`${shadows} shadow DOM component${shadows > 1 ? 's' : ''}`);

    return {
      url: location.href,
      title: document.title,
      scannedAt: new Date().toISOString(),
      words,
      elements: els.length,
      ms: Math.round(performance.now() - t0),
      unread,
      findings,
    };
  }

  globalThis.SlopScanner = { scan, score, cssPath, LIMITS };
})();
