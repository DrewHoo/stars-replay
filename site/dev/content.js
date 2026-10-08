// Inkwell Replay — content script.
// Records every visible change to the puzzle board on inkwellgames.com as a
// tiny stream of DOM diffs (not screenshots), then saves it for replay.
(() => {
  if (window.__inkwellReplay) return;

  const GRID_SEL = '[data-puzzle-grid]';
  const QUIET_MS = 250;          // a slot must be quiet this long before its new state is recorded
  const FORMAT_VERSION = 1;
  const ext = globalThis.browser || globalThis.chrome; // Firefox exposes browser.*, Chrome ext.*
  const hasChrome = !!(ext && ext.storage && ext.storage.local);

  // ---------- storage: ext.storage.local, with a localStorage fallback for dev injection ----------
  const store = {
    async get(key) {
      if (hasChrome) return (await ext.storage.local.get(key))[key];
      const v = localStorage.getItem('ir:' + key);
      return v ? JSON.parse(v) : undefined;
    },
    async set(key, val) {
      if (hasChrome) return ext.storage.local.set({ [key]: val });
      localStorage.setItem('ir:' + key, JSON.stringify(val));
    },
  };

  // ---------- helpers ----------
  function gameInfo() {
    const m = location.pathname.match(/\/games\/([^/]+)(?:\/(\d{4}-\d{2}-\d{2}))?/);
    return {
      game: m ? m[1] : 'unknown',
      date: m && m[2] ? m[2] : null,
      url: location.href,
      title: document.title,
    };
  }

  function findGrid() {
    return document.querySelector(GRID_SEL);
  }

  // The game pauses itself when you press ⏸ or leave the tab, and shows a
  // full-screen "Game Paused" overlay with a Resume button. A hidden tab counts
  // as paused too, since no move can happen while it is hidden.
  function isGamePaused() {
    if (document.hidden) return true;
    for (const overlay of document.querySelectorAll('.fixed.inset-0')) {
      if (/game paused/i.test(overlay.textContent)) return true;
      for (const b of overlay.querySelectorAll('button')) if (/^resume$/i.test(b.textContent.trim())) return true;
    }
    return false;
  }

  // The board root is the smallest ancestor of the grid that also contains any
  // clue markers (Mosaic puts its clue numbers outside the grid). For Stars this
  // is simply the grid's parent.
  function findRoot(grid) {
    let root = grid.parentElement;
    for (const clue of document.querySelectorAll('[aria-label^="Clue"]')) {
      while (root && !root.contains(clue)) root = root.parentElement;
    }
    return root || grid.parentElement;
  }

  function pathTo(root, el) {
    const path = [];
    while (el && el !== root) {
      const parent = el.parentElement;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, el));
      el = parent;
    }
    return el === root ? path : null;
  }

  function elAt(root, path) {
    let el = root;
    for (const i of path) el = el && el.children[i];
    return el || null;
  }

  // A "slot" is the smallest replaceable unit of the board: a cell (data-testid),
  // a clue button (aria-label), or a direct child of the grid (Stars' mark overlays).
  function slotFor(root, grid, node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== root) {
      if (el.hasAttribute('data-testid') || el.hasAttribute('aria-label') || el.parentElement === grid) return el;
      el = el.parentElement;
    }
    el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== root && el.parentElement !== root) el = el.parentElement;
    return el === root ? null : el;
  }

  // Round long floats so animation frames hash identically once they settle.
  function sanitize(html) {
    return html.replace(/-?\d+\.\d{3,}/g, (n) => String(Math.round(parseFloat(n) * 100) / 100));
  }

  // Serialize what the player actually sees. The game animates marks with the
  // Web Animations API, so an element's inline style may say opacity 0 / scale 0
  // forever while the rendered state lives in the animation. We bake the
  // computed opacity/transform into the snapshot and drop anything invisible.
  function visibleHtml(el) {
    const live = [el, ...el.querySelectorAll('*')];
    const computed = live.map((n) => {
      const cs = getComputedStyle(n);
      return { opacity: cs.opacity, transform: cs.transform, animated: n.style.opacity !== '' || n.style.transform !== '' };
    });
    const clone = el.cloneNode(true);
    const cloned = [clone, ...clone.querySelectorAll('*')];
    for (let i = cloned.length - 1; i >= 0; i--) {
      const c = computed[i];
      if (!c.animated) continue;
      const invisible = parseFloat(c.opacity) === 0 || /^matrix\(0, 0, 0, 0,/.test(c.transform);
      if (invisible) { if (i > 0) cloned[i].remove(); continue; }
      cloned[i].style.opacity = c.opacity === '1' ? '' : c.opacity;
      cloned[i].style.transform = c.transform === 'none' || c.transform === 'matrix(1, 0, 0, 1, 0, 0)' ? '' : c.transform;
    }
    return sanitize(clone.outerHTML);
  }

  function animating(el) {
    return el.getAnimations({ subtree: true }).some((a) => a.playState === 'running');
  }

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36) + str.length.toString(36);
  }

  function withTimeout(promise, ms, what) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);
  }

  async function gzipBase64(str) {
    if (typeof CompressionStream !== 'function') throw new Error('CompressionStream unavailable');
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(new TextEncoder().encode(str));
    writer.close();
    const bytes = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- recorder ----------
  class Recorder {
    constructor() {
      this.rec = null;
      this.pending = new Map(); // slotKey -> { path, first, timer }
      this.lastId = new Map();  // slotKey -> dict id of last recorded state
      this.baseClone = null;
      this.pausedAt = null;     // performance.now() when the current pause began
      this.pausedTotal = 0;     // ms of pause already excluded from the clock
    }

    get paused() { return this.pausedAt !== null; }

    // Pause/resume the recording clock. Paused time never reaches the
    // timeline; a 'pause' event notes how long the player was away.
    setPaused(on) {
      if (!this.rec || on === this.paused) return;
      if (on) {
        this.pausedAt = performance.now();
      } else {
        const away = Math.round(performance.now() - this.pausedAt);
        this.pausedTotal += away;
        this.pausedAt = null;
        this.rec.events.push([this.now(), 'pause', away]);
      }
      this.onEvent && this.onEvent();
    }

    get active() { return !!this.rec; }

    start() {
      const grid = findGrid();
      if (!grid) throw new Error('No puzzle grid found on this page.');
      const root = findRoot(grid);
      this.grid = grid;
      this.root = root;
      this.t0 = performance.now();
      const rootRect = root.getBoundingClientRect();
      const rootHtml = visibleHtml(root);
      this.rec = {
        v: FORMAT_VERSION,
        id: uid(),
        ...gameInfo(),
        startedAt: new Date().toISOString(),
        base: { html: rootHtml, width: Math.round(rootRect.width), height: Math.round(rootRect.height), gridPath: pathTo(root, grid) },
        palette: {},
        dict: {},
        events: [],
      };
      this.collectPalette(rootHtml);
      const tpl = document.createElement('template');
      tpl.innerHTML = rootHtml;
      this.baseClone = tpl.content.firstElementChild;

      this.mo = new MutationObserver((muts) => this.onMutations(muts));
      this.mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      this.onClick = (e) => this.recordUiClick(e);
      document.addEventListener('click', this.onClick, true);

      this.pausedAt = null;
      this.pausedTotal = 0;
      this.syncPause = () => this.setPaused(isGamePaused());
      this.pauseMo = new MutationObserver(this.syncPause);
      this.pauseMo.observe(document.body, { childList: true });
      document.addEventListener('visibilitychange', this.syncPause);
      this.syncPause();
    }

    collectPalette(html) {
      const cs = getComputedStyle(this.root);
      for (const m of html.matchAll(/var\(--([\w-]+)\)/g)) {
        const name = m[1];
        if (!(name in this.rec.palette)) this.rec.palette[name] = cs.getPropertyValue('--' + name).trim();
      }
    }

    now() {
      const live = this.paused ? this.pausedAt : performance.now();
      return Math.round(live - this.t0 - this.pausedTotal);
    }

    onMutations(muts) {
      if (!this.rec) return;
      const t = this.now();
      for (const m of muts) {
        if (m.type === 'childList' && (m.target === this.grid || m.target === this.root)) {
          for (const n of m.addedNodes) this.touch(n, t);
          for (const n of m.removedNodes) if (n.nodeType === 1) this.touch(m.target, t);
          continue;
        }
        this.touch(m.target, t);
      }
    }

    touch(node, t) {
      const slot = node === this.grid || node === this.root ? node : slotFor(this.root, this.grid, node);
      if (!slot) return;
      const path = pathTo(this.root, slot);
      if (!path) return;
      const key = path.join('.');
      let p = this.pending.get(key);
      if (!p) {
        p = { path, first: t, timer: null };
        this.pending.set(key, p);
      }
      clearTimeout(p.timer);
      p.timer = setTimeout(() => this.flush(key), QUIET_MS);
    }

    flush(key) {
      const p = this.pending.get(key);
      if (!p || !this.rec) return;
      this.pending.delete(key);
      clearTimeout(p.timer);
      const el = elAt(this.root, p.path);
      if (!el) return;
      if (animating(el) && (p.waited = (p.waited || 0) + 1) < 20) {
        this.pending.set(key, p);
        p.timer = setTimeout(() => this.flush(key), 100);
        return;
      }
      const html = visibleHtml(el);
      const id = this.intern(html);
      let prev = this.lastId.get(key);
      if (prev === undefined) {
        const baseEl = elAt(this.baseClone, p.path);
        prev = baseEl ? this.intern(sanitize(baseEl.outerHTML)) : null;
      }
      if (prev === id) return; // nothing visibly changed
      this.lastId.set(key, id);
      this.rec.events.push([p.first, p.path, id]);
      this.onEvent && this.onEvent();
    }

    intern(html) {
      const id = hash(html);
      if (!(id in this.rec.dict)) {
        this.rec.dict[id] = html;
        this.collectPalette(html);
      }
      return id;
    }

    recordUiClick(e) {
      if (!this.rec || this.paused) return;
      const btn = e.target && e.target.closest ? e.target.closest('button, a, [role="button"]') : null;
      if (!btn || this.root.contains(btn) || btn.closest('#inkwell-replay-widget')) return;
      const label = (btn.getAttribute('aria-label') || btn.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!label) return;
      this.rec.events.push([this.now(), 'ui', label]);
    }

    async stop() {
      if (!this.rec) return null;
      for (const key of [...this.pending.keys()]) this.flush(key);
      this.mo.disconnect();
      this.pauseMo.disconnect();
      document.removeEventListener('click', this.onClick, true);
      document.removeEventListener('visibilitychange', this.syncPause);
      this.setPaused(false);
      const rec = this.rec;
      this.rec = null;
      rec.endedAt = new Date().toISOString();
      rec.duration = this.now();

      // 1. Save first, uncompressed. Nothing below may cost us the recording.
      await saveRecording(rec);

      // 2. Share link: compact codec, else generic. Best effort.
      const viewerUrl = (typeof INKWELL_REPLAY_CONFIG !== 'undefined' && INKWELL_REPLAY_CONFIG.PUBLIC_VIEWER_URL) || '';
      if (viewerUrl && typeof InkwellShare !== 'undefined') {
        let fragment = null;
        try {
          const sem = typeof StarsCodec !== 'undefined' ? StarsCodec.fromGeneric(rec, rec.base.html) : null;
          if (sem && sem.skipped === 0) fragment = await withTimeout(StarsCodec.encodeFragment(sem), 5000, 'compact encoding');
        } catch (err) { console.warn('[inkwell-replay] compact encoding failed, using generic link', err); }
        if (!fragment) {
          try { fragment = await withTimeout(InkwellShare.fragment(rec, rec.base.html), 5000, 'generic encoding'); }
          catch (err) { console.warn('[inkwell-replay] could not build a share link', err); }
        }
        if (fragment) rec.shareUrl = viewerUrl + '#' + fragment;
      }

      // 3. Compress the stored copy if the browser lets us. Best effort.
      try {
        rec.base.htmlGz = await withTimeout(gzipBase64(rec.base.html), 5000, 'gzip');
        delete rec.base.html;
      } catch (err) { console.warn('[inkwell-replay] storing board uncompressed', err); }

      if (rec.shareUrl || rec.base.htmlGz) await store.set('rec:' + rec.id, rec);
      return rec;
    }
  }

  async function saveRecording(rec) {
    await store.set('rec:' + rec.id, rec);
    const index = (await store.get('index')) || [];
    index.unshift({
      id: rec.id, game: rec.game, date: rec.date, startedAt: rec.startedAt,
      duration: rec.duration, moves: rec.events.filter((e) => Array.isArray(e[1])).length,
    });
    await store.set('index', index);
  }

  // ---------- floating widget ----------
  const recorder = new Recorder();
  let widget;

  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function makeWidget() {
    const host = document.createElement('div');
    host.id = 'inkwell-replay-widget';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        .w { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; display: flex; gap: 8px; align-items: center;
             font: 600 13px/1 system-ui, sans-serif; background: #2f2525; color: #fafafa; padding: 8px 10px; border-radius: 10px;
             box-shadow: 0 4px 14px rgba(0,0,0,.25); }
        button { font: inherit; border: 0; border-radius: 7px; padding: 6px 10px; cursor: pointer; background: #fed23f; color: #2f2525; }
        button.rec { background: #e5484d; color: #fff; }
        .hide { display: none; }
      </style>
      <div class="w">
        <button id="toggle">● Record</button>
        <span id="status"></span>
        <button id="open" class="hide">Open replay</button><button id="share" class="hide" title="Copy a link that replays this recording">Copy link</button>
        <button id="copy" class="hide" title="Copy recording JSON">Copy JSON</button>
      </div>`;
    document.documentElement.appendChild(host);
    const $ = (id) => sh.getElementById(id);
    const toggle = $('toggle'), status = $('status'), open = $('open'), copy = $('copy'), share = $('share');
    let tick = null, last = null;

    function refresh() {
      if (recorder.active) {
        const moves = recorder.rec.events.filter((e) => Array.isArray(e[1])).length;
        status.textContent = (recorder.paused ? '⏸ ' : '') + fmt(recorder.now()) + ' · ' + moves + (moves === 1 ? ' move' : ' moves');
        if (!document.contains(recorder.grid)) stop(); // board was replaced (navigated to another day)
      }
    }

    async function start() {
      try {
        recorder.start();
      } catch (err) {
        status.textContent = err.message;
        return;
      }
      toggle.textContent = '■ Stop';
      toggle.classList.add('rec');
      open.classList.add('hide');
      copy.classList.add('hide');
      share.classList.add('hide');
      tick = setInterval(refresh, 500);
      refresh();
    }

    async function stop() {
      clearInterval(tick);
      try {
        last = await recorder.stop();
      } catch (err) {
        console.error('[inkwell-replay] stop failed', err);
        status.textContent = 'Stop failed: ' + (err && err.message ? err.message : err);
        last = null;
      }
      toggle.textContent = '● Record';
      toggle.classList.remove('rec');
      if (!last) return;
      const moves = last.events.filter((e) => Array.isArray(e[1])).length;
      status.textContent = 'Saved · ' + fmt(last.duration) + ' · ' + moves + ' moves';
      if (last.shareUrl) share.classList.remove('hide');
      if (hasChrome) {
        open.classList.remove('hide');
      } else {
        copy.classList.remove('hide');
      }
    }

    toggle.addEventListener('click', () => (recorder.active ? stop() : start()));
    open.addEventListener('click', () => {
      if (last) ext.runtime.sendMessage({ type: 'open-viewer', id: last.id });
    });
    share.addEventListener('click', async () => {
      if (!last || !last.shareUrl) return;
      await navigator.clipboard.writeText(last.shareUrl);
      status.textContent = 'Link copied (' + Math.round(last.shareUrl.length / 1000) + 'k chars)';
    });
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(JSON.stringify(last));
      status.textContent = 'Copied JSON to clipboard';
    });
    return { start, stop, get last() { return last; } };
  }

  function whenGridReady(cb) {
    if (findGrid()) return cb();
    const mo = new MutationObserver(() => {
      if (findGrid()) { mo.disconnect(); cb(); }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  whenGridReady(async () => {
    widget = makeWidget();
    if (await store.get('autoRecord')) widget.start();
  });

  window.__inkwellReplay = {
    recorder,
    start: () => widget && widget.start(),
    stop: () => widget && widget.stop(),
    exportJSON: () => JSON.stringify(widget && widget.last),
  };
})();
