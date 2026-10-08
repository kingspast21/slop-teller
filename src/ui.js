// Slop Teller UI: side panel, on-page marks, hover notes, export.
// Everything lives in one shadow root so the page's CSS can't touch it and
// ours can't touch the page. Copy marks are drawn as overlay rectangles from
// each match's Range: the CSS Custom Highlight API doesn't paint from an
// extension's isolated world, and overlays never change the page's DOM.
(() => {
  if (globalThis.__slopTeller) {
    globalThis.__slopTeller.open();
    return;
  }

  const HOST_TAG = 'slop-teller-root';
  const LAYERS = ['fingerprints', 'copy', 'design'];
  const LAYER_NAME = { fingerprints: 'Fingerprints', copy: 'Copy', design: 'Design' };
  const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const hostKey = 'keep:' + location.host;

  const state = {
    report: null,
    score: null,
    kept: new Set(),
    selected: new Set(),
    layerOn: { fingerprints: true, copy: true, design: true },
    open: {},
    cursor: {}, // finding id -> index into its on-page occurrences (-1 = not started)
    current: null, // {f, o} the occurrence last jumped to
    pin: null, // page label for the current occurrence
    boxes: [], // element outlines: {el, node, finding, rect}
    ranges: [], // copy marks: {range, finding, nodes, rects}
    raf: 0,
  };

  // ---------- shell ----------

  const host = document.createElement(HOST_TAG);
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${CSS()}</style>
    <div class="marks" part="marks"></div>
    <div class="note" hidden></div>
    <aside class="panel" role="dialog" aria-label="Slop Teller report">
      <header class="top">
        <div class="mark-word"><span class="w1">Slop</span><span class="w2">Teller</span></div>
        <div class="top-actions">
          <button class="icon-btn" data-act="rescan" title="Scan again">Rescan</button>
          <button class="icon-btn" data-act="close" title="Close (Esc)" aria-label="Close">&#x2715;</button>
        </div>
      </header>
      <div class="body"></div>
      <footer class="foot">
        <label class="sel-all"><input type="checkbox" data-act="select-all"> <span>Export selected only</span></label>
        <div class="foot-btns">
          <button class="btn ghost" data-act="copy-md">Copy .md</button>
          <button class="btn solid" data-act="export">Export .md</button>
        </div>
        <div class="toast" aria-live="polite"></div>
      </footer>
    </aside>`;
  document.documentElement.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const panel = $('.panel');
  const body = $('.body');
  const marks = $('.marks');
  const note = $('.note');

  // ---------- scan + render ----------

  async function loadKept() {
    if (!hasChromeStorage) return;
    try {
      const got = await chrome.storage.local.get(hostKey);
      state.kept = new Set(got[hostKey] || []);
    } catch (e) {
      /* storage unavailable */
    }
  }

  function saveKept() {
    if (!hasChromeStorage) return;
    try {
      chrome.storage.local.set({ [hostKey]: [...state.kept] });
    } catch (e) {
      /* ignore */
    }
  }

  function runScan() {
    clearMarks();
    host.style.display = 'none'; // keep our own UI out of layout reads
    state.report = globalThis.SlopScanner.scan();
    host.style.display = '';
    state.selected = new Set();
    state.cursor = {};
    state.current = null;
    rescore();
    paintMarks();
    render();
  }

  function rescore() {
    state.score = globalThis.SlopScanner.score(state.report, state.kept);
  }

  function render() {
    const r = state.report;
    const s = state.score;
    const total = r.findings.reduce((a, f) => a + f.occurrences.length, 0);

    let h = `
      <section class="score">
        <div class="score-num" data-band="${bandKey(s.band)}">${s.total}</div>
        <div class="score-meta">
          <div class="band">${s.band}</div>
          <div class="sub">${total} tell${total === 1 ? '' : 's'} in ${r.findings.length} kind${r.findings.length === 1 ? '' : 's'} &middot; ${r.words.toLocaleString()} words &middot; ${r.ms} ms</div>
        </div>
      </section>
      <section class="layers">
        ${LAYERS.map((l) => `
          <button class="layer ${state.layerOn[l] ? 'on' : ''}" data-act="layer" data-layer="${l}" title="Show or hide ${LAYER_NAME[l].toLowerCase()} marks on the page">
            <span class="swatch ${l}"></span>
            <span class="lname">${LAYER_NAME[l]}</span>
            <span class="lbar"><i style="width:${(s.layers[l] / s.limits[l]) * 100}%"></i></span>
            <span class="lval">${s.layers[l]}<small>/${s.limits[l]}</small></span>
          </button>`).join('')}
      </section>`;

    if (r.unread.length) {
      h += `<p class="unread">Couldn't read inside ${r.unread.join(', ')}. Check those by hand.</p>`;
    }

    if (!r.findings.length) {
      h += `<p class="empty">No tells found on this page.</p>`;
    }

    for (const layer of LAYERS) {
      const group = r.findings.filter((f) => f.layer === layer).sort((a, b) => b.points - a.points);
      if (!group.length) continue;
      h += `<section class="group"><h3><span class="swatch ${layer}"></span>${LAYER_NAME[layer]}</h3><ul class="tells">`;
      for (const f of group) {
        const kept = state.kept.has(f.id);
        const isOpen = !!state.open[f.id];
        const pts = kept ? 0 : s.contrib[f.id] || 0;
        h += `
          <li class="tell ${kept ? 'kept' : ''} ${isOpen ? 'open' : ''}" data-id="${f.id}">
            <div class="tell-row">
              <input type="checkbox" class="pick" data-act="pick" data-id="${f.id}" ${state.selected.has(f.id) ? 'checked' : ''} title="Include in a selected-only export" ${kept ? 'disabled' : ''}>
              <button class="tell-main" data-act="step" data-dir="1" data-id="${f.id}" title="${onPage(f).length ? 'Jump to the next one on the page' : 'Not visible on the page; see the list'}">
                <span class="tname">${escapeHtml(f.label)}</span>
              </button>
              ${stepperHtml(f)}
              <span class="tpts" title="Points this adds to the score">${kept ? 'kept' : '+' + pts}</span>
              <button class="chev" data-act="toggle" data-id="${f.id}" aria-expanded="${isOpen}" title="${isOpen ? 'Hide' : 'Show'} details and every place it appears" aria-label="Details">${isOpen ? '&#x2212;' : '+'}</button>
            </div>
            <div class="tell-detail">
              <p class="why">${escapeHtml(f.why)}</p>
              <ol class="occ">
                ${f.occurrences.slice(0, 60).map((o, i) => `
                  <li class="${state.current && state.current.o === o ? 'current' : ''}"><button data-act="goto" data-id="${f.id}" data-i="${i}" ${o.kind === 'source' ? 'data-source="1"' : ''}>
                    ${o.kind === 'source' ? '<span class="src">source</span>' : ''}${escapeHtml(o.snippet)}
                  </button></li>`).join('')}
                ${f.occurrences.length > 60 ? `<li class="more">...and ${f.occurrences.length - 60} more (all included in the export)</li>` : ''}
              </ol>
              <button class="keep" data-act="keep" data-id="${f.id}">${kept ? 'Count it again' : 'Keep as is (intentional)'}</button>
            </div>
          </li>`;
      }
      h += `</ul></section>`;
    }

    h += `<p class="disclaimer">The score counts tells, not proof. Real writers use em dashes, and some brands choose gradients on purpose.</p>`;
    const keepScroll = body.scrollTop;
    body.innerHTML = h;
    body.scrollTop = keepScroll;

    const selAll = $('[data-act="select-all"]');
    selAll.checked = state.selected.size > 0;
    selAll.disabled = state.selected.size === 0;
    $('.sel-all span').textContent = state.selected.size ? `Export ${state.selected.size} selected only` : 'Tick tells to export only those';
  }

  // ---------- stepping through occurrences ----------

  function onPage(f) {
    return f.occurrences.filter((o) => o.kind !== 'source');
  }

  function stepperHtml(f) {
    const list = onPage(f);
    const src = f.occurrences.length - list.length;
    if (!list.length) {
      return `<span class="stepper src-only" title="All ${f.occurrences.length} are in the page source, not on screen">${f.occurrences.length} in source</span>`;
    }
    const c = state.cursor[f.id];
    const pos = c == null || c < 0 ? '&ndash;' : c + 1;
    const off = state.kept.has(f.id) || !state.layerOn[f.layer];
    return `<span class="stepper" data-id="${f.id}" ${src ? `title="Plus ${src} in the page source (listed in details)"` : ''}>
        <button data-act="step" data-dir="-1" data-id="${f.id}" aria-label="Previous" ${off ? 'disabled' : ''}>&#x2039;</button>
        <span class="pos"><b>${pos}</b>/${list.length}${src ? '<i>+' + src + '</i>' : ''}</span>
        <button data-act="step" data-dir="1" data-id="${f.id}" aria-label="Next" ${off ? 'disabled' : ''}>&#x203A;</button>
      </span>`;
  }

  function step(f, dir) {
    const list = onPage(f);
    if (!list.length) {
      state.open[f.id] = true;
      render();
      toast('These are in the page source, not on screen. Details list where.');
      return;
    }
    if (state.kept.has(f.id)) {
      toast('Marked as kept. Click "Count it again" to show these on the page.');
      return;
    }
    if (!state.layerOn[f.layer]) {
      state.layerOn[f.layer] = true;
      paintMarks();
    }
    const c = state.cursor[f.id];
    let next = c == null || c < 0 ? (dir > 0 ? 0 : list.length - 1) : c + dir;
    next = (next + list.length) % list.length; // wrap around
    gotoOcc(f, f.occurrences.indexOf(list[next]));
  }

  function refreshStepper(f) {
    const li = body.querySelector(`.tell[data-id="${f.id}"]`);
    if (!li) return;
    const old = li.querySelector('.stepper');
    const tmp = document.createElement('div');
    tmp.innerHTML = stepperHtml(f);
    if (old) old.replaceWith(tmp.firstElementChild);
    body.querySelectorAll('.tell.active').forEach((x) => x.classList.remove('active'));
    li.classList.add('active');
    body.querySelectorAll('.occ li.current').forEach((x) => x.classList.remove('current'));
    const i = state.current ? f.occurrences.indexOf(state.current.o) : -1;
    const item = i >= 0 ? li.querySelectorAll('.occ li')[i] : null;
    if (item) {
      item.classList.add('current');
      if (li.classList.contains('open')) item.scrollIntoView({ block: 'nearest' });
    }
    li.scrollIntoView({ block: 'nearest' });
  }

  function bandKey(b) {
    return b.toLowerCase().replace(/\s+/g, '-');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- page marks ----------

  function clearMarks() {
    if (state.pin) {
      clearTimeout(state.pin.t);
      state.pin.node.remove();
      state.pin.target = null;
    }
    state.boxes = [];
    state.ranges = [];
    marks.innerHTML = '';
  }

  function paintMarks() {
    clearMarks();
    const live = state.report.findings.filter((f) => !state.kept.has(f.id) && state.layerOn[f.layer]);
    for (const f of live) {
      for (const o of f.occurrences) {
        if (o.kind === 'range' && o.range) {
          state.ranges.push({ range: o.range, finding: f, occ: o, nodes: [], rects: [] });
        } else if (o.kind === 'el' && o.el && o.el.isConnected) {
          const box = document.createElement('div');
          box.className = `box ${f.layer}`;
          box.innerHTML = `<span class="tag">${escapeHtml(f.short)}</span>`;
          marks.appendChild(box);
          state.boxes.push({ el: o.el, node: box, finding: f });
        }
      }
    }
    placeBoxes();
    setCurrentMark();
  }

  function placeBoxes() {
    const vw = innerWidth;
    const vh = innerHeight;
    // copy marks: one node per line box of the match
    for (const m of state.ranges) {
      let rects = [];
      try {
        rects = [...m.range.getClientRects()].filter((q) => q.width > 0 && q.bottom > 0 && q.top < vh && q.right > 0 && q.left < vw);
      } catch (e) {
        rects = [];
      }
      m.rects = rects;
      while (m.nodes.length < rects.length) {
        const n = document.createElement('div');
        n.className = 'hl';
        marks.appendChild(n);
        m.nodes.push(n);
      }
      const isCur = !!(state.current && state.current.o === m.occ);
      m.nodes.forEach((n, i) => {
        n.classList.toggle('current', isCur);
        const q = rects[i];
        if (!q) {
          n.style.display = 'none';
          return;
        }
        n.style.display = '';
        n.style.transform = `translate(${Math.round(q.left) - 1}px, ${Math.round(q.top)}px)`;
        n.style.width = Math.round(q.width) + 2 + 'px';
        n.style.height = Math.round(q.height) + 'px';
      });
    }
    // element outlines, with labels nudged apart so they never stack
    const tags = [];
    for (const b of state.boxes) {
      const r = b.el.getBoundingClientRect();
      const off = r.bottom < 0 || r.top > vh || r.width === 0;
      b.node.style.display = off ? 'none' : '';
      b.rect = off ? null : r;
      if (off) continue;
      b.node.style.transform = `translate(${Math.round(r.left) - 3}px, ${Math.round(r.top) - 3}px)`;
      b.node.style.width = Math.round(r.width) + 6 + 'px';
      b.node.style.height = Math.round(r.height) + 6 + 'px';
      const tag = b.node.firstChild;
      const tw = b.tagW || (b.tagW = tag.offsetWidth || 80);
      const inside = r.top < 22; // no room above: put the label inside the box
      let tx = 0;
      const ty = inside ? r.top : r.top - 20;
      for (let tries = 0; tries < 6; tries++) {
        const ax = r.left + tx;
        const clash = tags.find((t) => ax < t.x + t.w + 4 && ax + tw + 4 > t.x && Math.abs(ty - t.y) < 18);
        if (!clash) break;
        tx = clash.x + clash.w + 6 - r.left;
      }
      tags.push({ x: r.left + tx, y: ty, w: tw });
      tag.style.transform = `translate(${Math.round(tx)}px, ${inside ? 20 : 0}px)`;
    }
    placePin();
  }

  function schedulePlace() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      placeBoxes();
    });
  }

  // ---------- hover notes ----------

  let hoverT = 0;
  function onMove(e) {
    if (hoverT) return;
    hoverT = setTimeout(() => {
      hoverT = 0;
      hover(e.clientX, e.clientY, e.composedPath && e.composedPath()[0]);
    }, 40);
  }

  function hover(x, y, target) {
    if (host.style.display === 'none' || (target && target.getRootNode && target.getRootNode() === root)) {
      note.hidden = true;
      return;
    }
    let hit = null;
    for (const m of state.ranges) {
      if (m.rects.some((q) => x >= q.left - 2 && x <= q.right + 2 && y >= q.top - 2 && y <= q.bottom + 2)) {
        hit = m.finding;
        break;
      }
    }
    if (!hit) {
      // smallest element box under the pointer wins
      let best = null;
      for (const b of state.boxes) {
        const r = b.rect;
        if (!r || b.node.style.display === 'none') continue;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const area = r.width * r.height;
          if (!best || area < best.area) best = { area, f: b.finding };
        }
      }
      hit = best && best.f;
    }
    if (!hit) {
      note.hidden = true;
      return;
    }
    note.innerHTML = `<b class="${hit.layer}">${escapeHtml(hit.label)}</b><span>${escapeHtml(hit.why)}</span>`;
    note.hidden = false;
    const w = note.offsetWidth;
    const h = note.offsetHeight;
    const panelLeft = panel.getBoundingClientRect().left;
    let nx = x + 14;
    if (nx + w > panelLeft - 8) nx = Math.max(8, x - w - 14);
    let ny = y + 18;
    if (ny + h > innerHeight - 8) ny = y - h - 12;
    note.style.transform = `translate(${nx}px, ${ny}px)`;
  }

  // ---------- jump to an occurrence ----------

  function gotoOcc(f, i) {
    const o = f.occurrences[i];
    if (!o) return;
    if (o.kind === 'source') {
      toast('This one is in the page source, not on screen. It\'s in the export with its location.');
      return;
    }
    const target = o.kind === 'range' ? o.range.startContainer.parentElement : o.el;
    if (!target || !target.isConnected) {
      toast('That part of the page has changed. Rescan to refresh.');
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });

    const list = onPage(f);
    state.cursor[f.id] = list.indexOf(o);
    // other tells restart from their first item next time
    for (const k of Object.keys(state.cursor)) if (k !== f.id) state.cursor[k] = -1;
    state.current = { f, o };
    setCurrentMark();
    showPin(f, o, `${state.cursor[f.id] + 1} of ${list.length}`);
    refreshStepper(f);

    const flash = (nodes) =>
      nodes.forEach((n) => {
        n.classList.remove('flash');
        void n.offsetWidth;
        n.classList.add('flash');
      });
    if (o.kind === 'range') {
      const m = state.ranges.find((x) => x.occ === o);
      if (m) setTimeout(() => flash(m.nodes), 350);
    } else {
      const b = state.boxes.find((x) => x.el === o.el && x.finding === f);
      if (b) flash([b.node]);
    }
  }

  function setCurrentMark() {
    marks.querySelectorAll('.current').forEach((n) => n.classList.remove('current'));
    if (!state.current) return;
    const { f, o } = state.current;
    if (o.kind === 'range') {
      const m = state.ranges.find((x) => x.occ === o);
      if (m) m.nodes.forEach((n) => n.classList.add('current'));
    } else {
      const b = state.boxes.find((x) => x.el === o.el && x.finding === f);
      if (b) b.node.classList.add('current');
    }
  }

  function showPin(f, o, text) {
    if (!state.pin) {
      const n = document.createElement('div');
      n.className = 'pin';
      state.pin = { node: n };
    }
    const pin = state.pin;
    pin.target = o;
    pin.node.innerHTML = `<b>${escapeHtml(text)}</b><span>${escapeHtml(f.short)}</span>`;
    pin.node.className = `pin ${f.layer}`;
    marks.appendChild(pin.node); // keep on top of the other marks
    pin.w = 0;
    clearTimeout(pin.t);
    pin.node.classList.remove('fade');
    pin.t = setTimeout(() => pin.node.classList.add('fade'), 5000);
    placePin();
  }

  function placePin() {
    const pin = state.pin;
    if (!pin || !pin.target || !pin.node.isConnected) return;
    const o = pin.target;
    let r = null;
    try {
      r = o.kind === 'range' ? o.range.getBoundingClientRect() : o.el.getBoundingClientRect();
    } catch (e) {
      r = null;
    }
    if (!r || (r.width === 0 && r.height === 0) || r.bottom < 0 || r.top > innerHeight) {
      pin.node.style.display = 'none';
      return;
    }
    pin.node.style.display = '';
    const w = pin.w || (pin.w = pin.node.offsetWidth);
    const limit = panel.getBoundingClientRect().left - 8;
    const x = Math.max(6, Math.min(r.left, limit - w));
    const below = r.top < 34;
    const y = below ? r.bottom + 8 : r.top - 30;
    pin.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ---------- export ----------

  function markdown() {
    const only = state.selected.size ? new Set(state.selected) : null;
    return globalThis.SlopExport.build(state.report, state.score, { kept: state.kept, only });
  }

  function toast(msg) {
    const t = $('.toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- events ----------

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const f = id && state.report.findings.find((x) => x.id === id);
    if (act === 'close') api.close();
    else if (act === 'rescan') {
      runScan();
      toast('Scanned again.');
    } else if (act === 'toggle') {
      state.open[id] = !state.open[id];
      render();
    } else if (act === 'step') step(f, Number(btn.dataset.dir) || 1);
    else if (act === 'goto') gotoOcc(f, Number(btn.dataset.i));
    else if (act === 'keep') {
      if (state.kept.has(id)) state.kept.delete(id);
      else {
        state.kept.add(id);
        state.selected.delete(id);
      }
      saveKept();
      rescore();
      paintMarks();
      render();
    } else if (act === 'layer') {
      const l = btn.dataset.layer;
      state.layerOn[l] = !state.layerOn[l];
      paintMarks();
      render();
    } else if (act === 'export') {
      const md = markdown();
      globalThis.SlopExport.download(md, globalThis.SlopExport.filename(state.report));
      toast(state.selected.size ? `Exported ${state.selected.size} selected tell${state.selected.size === 1 ? '' : 's'}.` : 'Exported the full fix list.');
    } else if (act === 'copy-md') {
      try {
        await navigator.clipboard.writeText(markdown());
        toast('Markdown copied. Paste it into your AI assistant.');
      } catch (err) {
        toast('Clipboard blocked on this page. Use Export instead.');
      }
    }
  });

  root.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.act === 'pick') {
      if (el.checked) state.selected.add(el.dataset.id);
      else state.selected.delete(el.dataset.id);
      render();
    } else if (el.dataset.act === 'select-all' && !el.checked) {
      state.selected.clear();
      render();
    }
  });

  function onScroll() {
    note.hidden = true;
    schedulePlace();
  }

  function onKey(e) {
    if (host.style.display === 'none') return;
    if (e.key === 'Escape') api.close();
    // Alt+Down / Alt+Up step through the tell you last jumped in
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && state.current) {
      e.preventDefault();
      e.stopPropagation();
      step(state.current.f, e.key === 'ArrowDown' ? 1 : -1);
    }
  }

  function attach() {
    addEventListener('scroll', onScroll, { passive: true, capture: true });
    addEventListener('resize', schedulePlace, { passive: true });
    addEventListener('mousemove', onMove, { passive: true });
    addEventListener('keydown', onKey, true);
  }

  function detach() {
    removeEventListener('scroll', onScroll, { capture: true });
    removeEventListener('resize', schedulePlace);
    removeEventListener('mousemove', onMove);
    removeEventListener('keydown', onKey, true);
  }

  const api = {
    async open() {
      host.style.display = '';
      attach();
      await loadKept();
      runScan();
    },
    close() {
      host.style.display = 'none';
      note.hidden = true;
      clearMarks();
      detach();
    },
    toggle() {
      if (host.style.display === 'none') api.open();
      else api.close();
    },
    // for tests
    get state() {
      return state;
    },
    markdown,
  };
  globalThis.__slopTeller = api;
  api.open();

  // ---------- styles ----------

  function CSS() {
    return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
    button:focus-visible, input:focus-visible { outline: 2px solid #d63020; outline-offset: 2px; }

    .marks { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
    .hl { position: absolute; left: 0; top: 0; background: rgba(255, 214, 10, 0.38); border-bottom: 2px solid #f0b400; pointer-events: none; }
    .hl.flash { animation: hlflash 0.6s ease-out 2; }
    @keyframes hlflash { 0%, 100% { background: rgba(255, 214, 10, 0.38); } 40% { background: rgba(214, 48, 32, 0.55); } }
    .box { position: absolute; left: 0; top: 0; border: 2px solid; pointer-events: none; }
    .box.design { border-color: #1f4fd1; border-style: dashed; background: rgba(31, 79, 209, 0.04); }
    .box.fingerprints { border-color: #d63020; background: rgba(214, 48, 32, 0.08); }
    .hl.current { background: rgba(214, 48, 32, 0.32); border-bottom-color: #d63020; }
    .box.current { border-style: solid; border-color: #d63020; border-width: 3px; }
    .box.current .tag { background: #d63020; }
    .pin { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 8px; padding: 5px 8px; background: #1b1a17; color: #f4f1ea;
      font: 600 11px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; letter-spacing: .03em; white-space: nowrap; box-shadow: 3px 3px 0 #d63020; transition: opacity .4s; }
    .pin b { color: #fff; }
    .pin span { color: #c9c2b2; text-transform: uppercase; font-weight: 400; }
    .pin.fade { opacity: 0; }
    .box .tag { position: absolute; left: -2px; top: -20px; transform-origin: 0 0; font: 600 10px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; letter-spacing: .04em; text-transform: uppercase; padding: 4px 5px; color: #fff; white-space: nowrap; }
    .box.design .tag { background: #1f4fd1; }
    .box.fingerprints .tag { background: #d63020; }
    .box.flash { animation: flash 0.9s ease-out 1; }
    @keyframes flash { 0%, 100% { box-shadow: 0 0 0 0 rgba(214,48,32,0); } 30% { box-shadow: 0 0 0 6px rgba(214,48,32,.45); } }

    .note { position: fixed; left: 0; top: 0; max-width: 300px; background: #1b1a17; color: #f4f1ea; padding: 10px 12px; font: 13px/1.45 Georgia, "Iowan Old Style", "Times New Roman", serif; pointer-events: none; box-shadow: 4px 4px 0 rgba(0,0,0,.18); }
    .note b { display: block; font: 600 11px/1.3 ui-monospace, "Cascadia Mono", Consolas, monospace; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
    .note b.copy { color: #ffd60a; } .note b.design { color: #8fb0ff; } .note b.fingerprints { color: #ff7a66; }

    .panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(380px, 100vw); display: flex; flex-direction: column; pointer-events: auto;
      background: #f4f1ea; color: #1b1a17; border-left: 2px solid #1b1a17; font: 14px/1.45 Georgia, "Iowan Old Style", "Times New Roman", serif;
      box-shadow: -10px 0 0 rgba(27,26,23,.06); }
    .top { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 10px 18px; border-bottom: 2px solid #1b1a17; }
    .mark-word { font: 700 20px/1 Georgia, "Times New Roman", serif; letter-spacing: -.01em; }
    .mark-word .w1 { text-decoration: line-through 3px #d63020; text-decoration-skip-ink: none; }
    .mark-word .w2 { margin-left: 6px; font-style: italic; font-weight: 400; }
    .top-actions { display: flex; gap: 4px; align-items: center; }
    .icon-btn { font: 600 11px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; text-transform: uppercase; letter-spacing: .05em; padding: 7px 8px; border: 1px solid transparent; }
    .icon-btn:hover { border-color: #1b1a17; }

    .body { flex: 1; overflow-y: auto; padding: 0 18px 18px; scrollbar-width: thin; }
    .score { display: flex; align-items: flex-end; gap: 14px; padding: 18px 0 14px; border-bottom: 1px solid #c9c2b2; }
    .score-num { font: 400 76px/0.8 Georgia, "Times New Roman", serif; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
    .score-num[data-band="heavy"], .score-num[data-band="many-tells"] { color: #d63020; }
    .band { font: 700 13px/1.2 ui-monospace, "Cascadia Mono", Consolas, monospace; text-transform: uppercase; letter-spacing: .06em; }
    .sub { color: #5c574c; font-size: 12.5px; margin-top: 4px; }

    .layers { display: grid; gap: 2px; padding: 12px 0; border-bottom: 1px solid #c9c2b2; }
    .layer { display: grid; grid-template-columns: 12px 92px 1fr 46px; gap: 10px; align-items: center; padding: 5px 0; text-align: left; opacity: .45; }
    .layer.on { opacity: 1; }
    .lname { font-size: 13.5px; }
    .lbar { height: 6px; background: #ddd6c6; position: relative; }
    .lbar i { position: absolute; inset: 0 auto 0 0; background: #1b1a17; }
    .lval { font: 600 12px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; text-align: right; font-variant-numeric: tabular-nums; }
    .lval small { color: #8a8475; font-weight: 400; }
    .swatch { width: 12px; height: 12px; display: inline-block; flex: none; }
    .swatch.copy { background: #ffd60a; box-shadow: inset 0 -3px 0 #b8860b; }
    .swatch.design { border: 2px dashed #1f4fd1; }
    .swatch.fingerprints { background: #d63020; }

    .unread { margin: 12px 0 0; padding: 8px 10px; border-left: 3px solid #1b1a17; background: #ebe6da; font-size: 13px; }
    .empty { margin: 18px 0; font-style: italic; }

    .group h3 { display: flex; align-items: center; gap: 8px; margin: 18px 0 6px; font: 700 11px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; text-transform: uppercase; letter-spacing: .08em; }
    .tells { list-style: none; margin: 0; padding: 0; }
    .tell { border-top: 1px solid #ddd6c6; }
    .tell-row { display: grid; grid-template-columns: 18px 1fr auto 34px 18px; gap: 6px; align-items: center; padding: 6px 0; }
    .tell.active { box-shadow: inset 3px 0 0 #d63020; margin-left: -10px; padding-left: 10px; }
    .stepper { display: inline-flex; align-items: center; font: 600 11.5px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; color: #5c574c; font-variant-numeric: tabular-nums; }
    .stepper button { width: 20px; height: 22px; font: 400 16px/1 Georgia, serif; color: #1b1a17; }
    .stepper button:hover:not(:disabled) { background: #1b1a17; color: #f4f1ea; }
    .stepper button:disabled { color: #b5ae9e; cursor: default; }
    .stepper .pos { min-width: 40px; text-align: center; }
    .stepper .pos b { color: #1b1a17; }
    .stepper .pos i { font-style: normal; color: #8a8475; margin-left: 2px; }
    .stepper.src-only { font-weight: 400; font-size: 11px; color: #8a8475; padding-right: 4px; }
    .tell.active .stepper .pos b { color: #d63020; }
    .chev { width: 18px; height: 22px; font: 400 15px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; color: #5c574c; }
    .chev:hover { color: #1b1a17; background: #e4ded0; }
    .occ li.current > button { color: #d63020; font-weight: 600; }
    .pick { margin: 0; accent-color: #1b1a17; width: 14px; height: 14px; }
    .tell-main { display: block; text-align: left; min-width: 0; padding: 2px 0; }
    .tell-main:hover .tname { text-decoration: underline; text-underline-offset: 3px; }
    .tname { font-size: 14px; }
    .tcount { font: 600 12px/1.6 ui-monospace, "Cascadia Mono", Consolas, monospace; color: #5c574c; }
    .tpts { font: 600 11.5px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; min-width: 32px; text-align: right; color: #d63020; }
    .tell.kept .tname { text-decoration: line-through; color: #8a8475; }
    .tell.kept .tpts { color: #8a8475; }
    .tell-detail { display: none; padding: 0 0 12px 26px; }
    .tell.open .tell-detail { display: block; }
    .why { margin: 0 0 8px; font-size: 13px; color: #3d3a33; font-style: italic; }
    .occ { margin: 0 0 10px; padding: 0 0 0 18px; max-height: 220px; overflow-y: auto; font-size: 12.5px; }
    .occ li { margin: 0 0 4px; color: #5c574c; }
    .occ button { text-align: left; color: #1b1a17; line-height: 1.4; }
    .occ button:hover { color: #d63020; }
    .occ .src { font: 600 9.5px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; text-transform: uppercase; border: 1px solid currentColor; padding: 1px 3px; margin-right: 6px; vertical-align: 1px; }
    .occ .more { font-style: italic; list-style: none; margin-left: -18px; }
    .keep { font: 600 11px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid currentColor; padding-bottom: 2px; }
    .keep:hover { color: #d63020; }
    .disclaimer { margin: 20px 0 0; font-size: 12px; color: #8a8475; font-style: italic; }

    .foot { position: relative; border-top: 2px solid #1b1a17; padding: 12px 18px 14px; display: grid; gap: 10px; }
    .sel-all { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: #5c574c; }
    .sel-all input { margin: 0; accent-color: #1b1a17; }
    .foot-btns { display: grid; grid-template-columns: 1fr 1.4fr; gap: 8px; }
    .btn { font: 700 12px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; text-transform: uppercase; letter-spacing: .06em; padding: 12px 10px; border: 2px solid #1b1a17; }
    .btn.solid { background: #1b1a17; color: #f4f1ea; }
    .btn.solid:hover { background: #d63020; border-color: #d63020; }
    .btn.ghost:hover { background: #ebe6da; }
    .toast { position: absolute; left: 18px; right: 18px; bottom: calc(100% + 8px); background: #1b1a17; color: #f4f1ea; padding: 8px 10px; font-size: 13px; opacity: 0; transform: translateY(4px); transition: opacity .2s, transform .2s; pointer-events: none; }
    .toast.show { opacity: 1; transform: none; }
    @media (prefers-reduced-motion: reduce) { .toast, .pin { transition: none; } .box.flash, .hl.flash { animation: none; outline: 3px solid #d63020; } }
    `;
  }
})();
