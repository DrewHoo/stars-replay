// Inkwell Replay — Stars codec.
// Turns a generic DOM-diff recording of a Stars solve into a semantic one
// (regions, marks, hint tints, highlighter cells, buttons, pauses), packs it
// into a compact byte stream for share links, and draws its own board so the
// viewer does not need the site's markup at all.
const StarsCodec = (() => {
  const MAGIC = 0x53; // 'S'
  const VERSION = 1;
  const EPOCH_DAY = Date.UTC(2025, 0, 1) / 86400000;
  const KIND = { MARK: 0, BG: 1, HILITE: 2, UI: 3, PAUSE: 4 };
  const UI_LABELS = ['Undo', 'Hint', 'Check', 'Toggle highlighter', 'Reset Puzzle', 'Resume'];
  const DEFAULT_COLORS = { 'coral-300': '#ff7868', 'yellow-default': '#fed23f', 'orange-300': '#ff9c4b', 'white': '#fafafa', 'black': '#2f2525', 'gray-300': '#bdbdbd', 'gray-400': '#8b8b8b' };
  const HILITE_FILL = '#8575FC';
  const GLYPHS = {"star":{"viewBox":"0 0 44 43","paths":[{"d":"M17.51 35.49L22.27 32.91L27.03 35.49C27.65 35.84 28.32 36 29 36C29.84 36 30.69 35.73 31.41 35.21C32.7 34.27 33.33 32.7 33.03 31.13L32.05 25.78L35.98 22.04C37.15 20.94 37.56 19.3 37.06 17.78C36.56 16.25 35.27 15.17 33.69 14.96L28.31 14.25L25.98 9.35C25.06 7.43 22.86 6.53 20.87 7.25C19.84 7.61 19.03 8.36 18.56 9.35L16.22 14.25L10.85 14.96C9.26 15.17 7.97 16.25 7.47 17.78C6.98 19.3 7.39 20.94 8.55 22.04L12.48 25.78L11.5 31.13C11.2 32.7 11.83 34.27 13.12 35.21C14.41 36.15 16.09 36.26 17.5 35.49","fill":"var(--black)"},{"d":"M33.73 19.67C34.25 19.18 33.97 18.3 33.26 18.21L26.65 17.33C26.33 17.29 26.05 17.08 25.9 16.79L23.03 10.76C22.83 10.33 22.36 10.18 21.98 10.33C21.78 10.4 21.6 10.54 21.5 10.76L18.63 16.79C18.49 17.08 18.21 17.29 17.89 17.33L11.28 18.21C10.57 18.3 10.28 19.18 10.8 19.67L15.63 24.27C15.87 24.49 15.97 24.83 15.91 25.15L14.7 31.72C14.57 32.43 15.31 32.96 15.94 32.62L21.8 29.43C21.8 29.43 21.81 29.43 21.82 29.42C22.1 29.28 22.44 29.28 22.72 29.43L28.58 32.62C29.21 32.96 29.95 32.42 29.82 31.72L28.6 25.15C28.55 24.83 28.65 24.5 28.89 24.27L33.72 19.67H33.73Z","fill":"var(--yellow-default)"},{"d":"M21.51 10.76L18.64 16.79C18.49 17.08 18.22 17.29 17.89 17.33L11.28 18.21C10.58 18.3 10.29 19.18 10.81 19.67L15.64 24.27C15.88 24.49 15.98 24.83 15.92 25.15L14.71 31.72C14.58 32.43 15.32 32.96 15.95 32.62L21.81 29.43C21.81 29.43 21.82 29.43 21.83 29.42C20.12 22.32 20.9 15.57 21.97 10.32C21.77 10.39 21.6 10.54 21.49 10.75L21.51 10.76Z","fill":"var(--orange-300)"}]},"x":{"viewBox":"0 0 43 43","paths":[{"d":"M24.36 17.21C24.75 16.82 25.39 16.82 25.79 17.21C26.18 17.61 26.18 18.25 25.79 18.64L22.93 21.5L25.79 24.36C26.18 24.75 26.18 25.39 25.79 25.79C25.39 26.18 24.75 26.18 24.36 25.79L21.5 22.93L18.64 25.79C18.25 26.18 17.61 26.18 17.21 25.79C16.82 25.39 16.82 24.75 17.21 24.36L20.07 21.5L17.21 18.64C16.82 18.25 16.82 17.61 17.21 17.21C17.61 16.82 18.25 16.82 18.64 17.21L21.5 20.07L24.36 17.21Z","fill":"var(--gray-400)"}]}};

  // ---------- byte helpers ----------
  class Writer {
    constructor() { this.b = []; }
    u8(v) { this.b.push(v & 255); }
    u16(v) { this.u8(v); this.u8(v >> 8); }
    varint(v) { v = Math.max(0, Math.round(v)); while (v >= 128) { this.b.push((v % 128) | 128); v = Math.floor(v / 128); } this.b.push(v); }
    bytes(arr) { for (const x of arr) this.u8(x); }
    str(s) { const e = new TextEncoder().encode(s); this.varint(e.length); this.bytes(e); }
    out() { return new Uint8Array(this.b); }
  }
  class Reader {
    constructor(u8) { this.u = u8; this.i = 0; }
    u8() { if (this.i >= this.u.length) throw new Error('truncated'); return this.u[this.i++]; }
    u16() { return this.u8() | (this.u8() << 8); }
    varint() { let v = 0, m = 1, b; do { b = this.u8(); v += (b & 127) * m; m *= 128; } while (b & 128); return v; }
    bytes(n) { const s = this.u.subarray(this.i, this.i + n); this.i += n; return s; }
    str() { return new TextDecoder().decode(this.bytes(this.varint())); }
  }
  function toB64(bytes) {
    let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
  }
  async function deflate(bytes) {
    const cs = new CompressionStream('deflate-raw'); const w = cs.writable.getWriter(); w.write(bytes); w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate-raw'); const w = ds.writable.getWriter(); w.write(bytes); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }

  // ---------- generic recording -> semantic ----------
  function parseHtml(html) {
    const doc = new DOMParser().parseFromString('<body>' + html, 'text/html');
    return doc.body.firstElementChild;
  }
  function cellOfTestid(el) {
    const m = (el.getAttribute('data-testid') || '').match(/^puzzle-cell-(\d+)-(\d+)$/);
    return m ? [+m[1], +m[2]] : null;
  }
  function varName(value) { const m = /var\(--([\w-]+)\)/.exec(value || ''); return m ? m[1] : null; }
  function markState(html) {
    if (/var\(--yellow-default\)/.test(html)) return 2;
    if (/viewBox="0 0 43 43"/.test(html)) return 1;
    return 0;
  }

  // Which cells does a set of highlighter paths cover? Decided geometrically
  // with isPointInFill on a scratch SVG, so the path shape never matters.
  function hiliteCells(layerHtml, n) {
    const cells = new Array(n * n).fill(false);
    const el = parseHtml(layerHtml);
    const paths = el ? [...el.querySelectorAll('path')] : [];
    if (!paths.length) return cells;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
    svg.setAttribute('width', '10'); svg.setAttribute('height', '10');
    svg.style.cssText = 'position:absolute;left:-9999px;top:-9999px';
    const live = paths.map((p) => { const q = document.createElementNS(NS, 'path'); q.setAttribute('d', p.getAttribute('d') || ''); svg.appendChild(q); return q; });
    document.body.appendChild(svg);
    try {
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        const pt = new DOMPoint(c + 0.5, r + 0.5);
        if (live.some((q) => q.isPointInFill(pt))) cells[r * n + c] = true;
      }
    } finally { svg.remove(); }
    return cells;
  }

  function regionsFromWalls(grid, n) {
    const vwall = Array.from({ length: n }, () => new Array(n + 1).fill(false)); // vwall[r][k]: wall left of (r,k)
    const hwall = Array.from({ length: n + 1 }, () => new Array(n).fill(false)); // hwall[k][c]: wall above (k,c)
    for (const line of grid.querySelectorAll('svg:not([preserveAspectRatio]) line')) {
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((a) => +line.getAttribute(a));
      if (x1 === x2) for (let r = Math.min(y1, y2); r < Math.max(y1, y2); r++) vwall[r][x1] = true;
      else if (y1 === y2) for (let c = Math.min(x1, x2); c < Math.max(x1, x2); c++) hwall[y1][c] = true;
    }
    const regions = new Array(n * n).fill(-1);
    let next = 0;
    for (let s = 0; s < n * n; s++) {
      if (regions[s] !== -1) continue;
      const stack = [s]; regions[s] = next;
      while (stack.length) {
        const i = stack.pop(); const r = Math.floor(i / n), c = i % n;
        const step = (j) => { if (regions[j] === -1) { regions[j] = next; stack.push(j); } };
        if (c > 0 && !vwall[r][c]) step(i - 1);
        if (c < n - 1 && !vwall[r][c + 1]) step(i + 1);
        if (r > 0 && !hwall[r][c]) step(i - n);
        if (r < n - 1 && !hwall[r + 1][c]) step(i + n);
      }
      next++;
    }
    return regions;
  }

  // Describe what a slot (by path into the base board) represents.
  function slotInfo(baseRoot, grid, n, path) {
    let el = baseRoot; for (const i of path) el = el && el.children[i];
    if (!el) return null;
    const rc = cellOfTestid(el);
    if (rc) return { type: 'bg', cell: rc[0] * n + rc[1] };
    if (el.querySelector && el.querySelector('svg[preserveAspectRatio]')) return { type: 'hilite' };
    if (el.parentElement === grid && el.style && el.style.padding === '1px') {
      const c = Math.round(parseFloat(el.style.left) * n / 100), r = Math.round(parseFloat(el.style.top) * n / 100);
      if (r >= 0 && r < n && c >= 0 && c < n) return { type: 'mark', cell: r * n + c };
    }
    return null;
  }
  function bgColorOf(cellEl) {
    const inner = cellEl.firstElementChild;
    const name = inner ? varName(inner.style.backgroundColor) : null;
    return !name || name === 'white' ? null : name;
  }

  // rec: generic recording; baseHtml: its decompressed board HTML.
  // Returns a semantic recording, or null if this does not look like Stars.
  function fromGeneric(rec, baseHtml) {
    if (rec.game && rec.game !== 'stars') return null;
    const baseRoot = parseHtml(baseHtml);
    const grid = baseRoot && baseRoot.querySelector('[data-puzzle-grid]');
    if (!grid) return null;
    let n = 0;
    for (const cell of grid.querySelectorAll('[data-testid^="puzzle-cell-"]')) { const rc = cellOfTestid(cell); if (rc) n = Math.max(n, rc[0] + 1, rc[1] + 1); }
    if (!n || n > 15) return null;
    const regions = regionsFromWalls(grid, n);
    const palette = rec.palette || {};
    const colors = [];
    const colorIdx = (name) => { let i = colors.indexOf(name); if (i < 0) { i = colors.length; colors.push(name); } return i; };

    const initial = [];
    for (const cell of grid.querySelectorAll('[data-testid^="puzzle-cell-"]')) {
      const rc = cellOfTestid(cell); const name = bgColorOf(cell);
      if (rc && name) initial.push({ kind: KIND.BG, cell: rc[0] * n + rc[1], color: colorIdx(name) });
    }
    for (const ov of grid.children) {
      if (ov.style && ov.style.padding === '1px' && ov.children.length) {
        const info = slotInfo(baseRoot, grid, n, pathTo(baseRoot, ov));
        const state = markState(ov.outerHTML);
        if (info && state) initial.push({ kind: KIND.MARK, cell: info.cell, state });
      }
    }
    const layer = grid.querySelector('svg[preserveAspectRatio]');
    if (layer && layer.querySelector('path')) initial.push({ kind: KIND.HILITE, cells: hiliteCells(layer.parentElement.outerHTML, n) });

    const events = [];
    let skipped = 0;
    for (const e of rec.events) {
      const t = e[0];
      if (e[1] === 'ui') { events.push({ t, kind: KIND.UI, label: e[2] }); continue; }
      if (e[1] === 'pause') { events.push({ t, kind: KIND.PAUSE, away: e[2] }); continue; }
      if (!Array.isArray(e[1])) { skipped++; continue; }
      const info = slotInfo(baseRoot, grid, n, e[1]);
      const html = rec.dict[e[2]] || '';
      if (!info) { skipped++; continue; }
      if (info.type === 'mark') events.push({ t, kind: KIND.MARK, cell: info.cell, state: markState(html) });
      else if (info.type === 'bg') { const el = parseHtml(html); const name = el ? bgColorOf(el) : null; events.push({ t, kind: KIND.BG, cell: info.cell, color: name ? colorIdx(name) + 1 : 0 }); }
      else if (info.type === 'hilite') events.push({ t, kind: KIND.HILITE, cells: hiliteCells(html, n) });
    }
    // BG color 0 means "clear"; shift initial ops to the same 1-based scheme.
    for (const op of initial) if (op.kind === KIND.BG) op.color += 1;
    return {
      game: 'stars', n, regions, date: rec.date || null, startedAt: rec.startedAt || null,
      duration: rec.duration || (events.length ? events[events.length - 1].t : 0),
      colors: colors.map((name) => ({ name, hex: palette[name] || DEFAULT_COLORS[name] || '#ff7868' })),
      initial, events, skipped,
    };
  }
  function pathTo(root, el) {
    const path = [];
    while (el && el !== root) { const p = el.parentElement; if (!p) return null; path.unshift(Array.prototype.indexOf.call(p.children, el)); el = p; }
    return path;
  }

  // ---------- semantic <-> bytes ----------
  function writeOp(w, op, n) {
    w.u8(op.kind);
    if (op.kind === KIND.MARK) { w.varint(op.cell); w.u8(op.state); }
    else if (op.kind === KIND.BG) { w.varint(op.cell); w.u8(op.color); }
    else if (op.kind === KIND.HILITE) { const bytes = new Uint8Array(Math.ceil(n * n / 8)); op.cells.forEach((on, i) => { if (on) bytes[i >> 3] |= 1 << (i & 7); }); w.bytes(bytes); }
    else if (op.kind === KIND.UI) { const i = UI_LABELS.indexOf(op.label); if (i >= 0) w.u8(i); else { w.u8(255); w.str(op.label); } }
    else if (op.kind === KIND.PAUSE) w.varint(op.away);
  }
  function readOp(r, n) {
    const kind = r.u8();
    if (kind === KIND.MARK) return { kind, cell: r.varint(), state: r.u8() };
    if (kind === KIND.BG) return { kind, cell: r.varint(), color: r.u8() };
    if (kind === KIND.HILITE) { const bytes = r.bytes(Math.ceil(n * n / 8)); const cells = []; for (let i = 0; i < n * n; i++) cells.push(!!(bytes[i >> 3] & (1 << (i & 7)))); return { kind, cells }; }
    if (kind === KIND.UI) { const i = r.u8(); return { kind, label: i === 255 ? r.str() : UI_LABELS[i] || 'button' }; }
    if (kind === KIND.PAUSE) return { kind, away: r.varint() };
    throw new Error('bad op ' + kind);
  }
  function toBytes(sem) {
    const w = new Writer();
    w.u8(MAGIC); w.u8(VERSION); w.u8(sem.n);
    const day = sem.date ? Math.round(Date.parse(sem.date + 'T00:00:00Z') / 86400000 - EPOCH_DAY) : 0;
    w.u16(Math.max(0, day));
    w.varint(sem.startedAt ? Math.round(Date.parse(sem.startedAt) / 60000 - EPOCH_DAY * 1440) : 0);
    w.varint(sem.duration);
    for (let i = 0; i < sem.n * sem.n; i += 2) w.u8((sem.regions[i] & 15) | ((sem.regions[i + 1] || 0) << 4));
    w.u8(sem.colors.length);
    for (const c of sem.colors) { w.str(c.name); const h = c.hex.replace('#', ''); w.u8(parseInt(h.slice(0, 2), 16)); w.u8(parseInt(h.slice(2, 4), 16)); w.u8(parseInt(h.slice(4, 6), 16)); }
    w.varint(sem.initial.length);
    for (const op of sem.initial) writeOp(w, op, sem.n);
    w.varint(sem.events.length);
    let last = 0;
    for (const ev of sem.events) { w.varint(ev.t - last); last = ev.t; writeOp(w, ev, sem.n); }
    return w.out();
  }
  function fromBytes(u8) {
    const r = new Reader(u8);
    if (r.u8() !== MAGIC) throw new Error('not a Stars replay');
    const version = r.u8(); if (version !== VERSION) throw new Error('unsupported version ' + version);
    const n = r.u8();
    const day = r.u16();
    const date = day ? new Date((day + EPOCH_DAY) * 86400000).toISOString().slice(0, 10) : null;
    const startMin = r.varint();
    const startedAt = startMin ? new Date((startMin + EPOCH_DAY * 1440) * 60000).toISOString() : null;
    const duration = r.varint();
    const regions = [];
    for (let i = 0; i < n * n; i += 2) { const b = r.u8(); regions.push(b & 15); if (i + 1 < n * n) regions.push(b >> 4); }
    const colors = [];
    const nc = r.u8();
    for (let i = 0; i < nc; i++) { const name = r.str(); const hex = '#' + [r.u8(), r.u8(), r.u8()].map((x) => x.toString(16).padStart(2, '0')).join(''); colors.push({ name, hex }); }
    const initial = []; const ni = r.varint();
    for (let i = 0; i < ni; i++) initial.push(readOp(r, n));
    const events = []; const ne = r.varint(); let t = 0;
    for (let i = 0; i < ne; i++) { t += r.varint(); events.push({ t, ...readOp(r, n) }); }
    return { game: 'stars', n, regions, date, startedAt, duration, colors, initial, events, skipped: 0 };
  }

  // Share-link fragment: "s=" raw bytes or "z=" deflated, whichever is shorter.
  async function encodeFragment(sem) {
    const raw = toBytes(sem);
    const packed = await deflate(raw);
    return packed.length + 2 < raw.length ? 'z=' + toB64(packed) : 's=' + toB64(raw);
  }
  async function decodeFragment(fragment) {
    const m = /^#?([sz])=(.+)$/.exec(fragment);
    if (!m) return null;
    const bytes = fromB64(m[2]);
    return fromBytes(m[1] === 'z' ? await inflate(bytes) : bytes);
  }

  // ---------- rendering ----------
  // Draws the board as SVG and applies ops to it. Returns a controller.
  function render(container, sem) {
    const NS = 'http://www.w3.org/2000/svg';
    const n = sem.n;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `-0.12 -0.12 ${n + 0.24} ${n + 0.24}`);
    svg.setAttribute('class', 'stars-board');
    svg.style.cssText = 'display:block;width:100%;height:auto;font-family:inherit';
    const mk = (tag, attrs, parent = svg) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); parent.appendChild(el); return el; };
    mk('rect', { x: 0, y: 0, width: n, height: n, rx: 0.2, fill: '#fafafa' });
    const bgLayer = mk('g', {});
    const hiLayer = mk('g', {});
    const gridLayer = mk('g', { stroke: '#bdbdbd', 'stroke-width': 0.03 });
    for (let k = 1; k < n; k++) { mk('line', { x1: k, y1: 0, x2: k, y2: n }, gridLayer); mk('line', { x1: 0, y1: k, x2: n, y2: k }, gridLayer); }
    const wallLayer = mk('g', { stroke: '#2f2525', 'stroke-width': 0.11, 'stroke-linecap': 'round' });
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (c < n - 1 && sem.regions[i] !== sem.regions[i + 1]) mk('line', { x1: c + 1, y1: r, x2: c + 1, y2: r + 1 }, wallLayer);
      if (r < n - 1 && sem.regions[i] !== sem.regions[i + n]) mk('line', { x1: c, y1: r + 1, x2: c + 1, y2: r + 1 }, wallLayer);
    }
    mk('rect', { x: 0, y: 0, width: n, height: n, rx: 0.2, fill: 'none', stroke: '#2f2525', 'stroke-width': 0.18 });
    const markLayer = mk('g', {});
    container.appendChild(svg);

    const marks = new Array(n * n).fill(0), bgs = new Array(n * n).fill(0);
    let hil = new Array(n * n).fill(false);
    const markEls = new Array(n * n).fill(null), bgEls = new Array(n * n).fill(null);

    function drawMark(cell, state) {
      if (markEls[cell]) { markEls[cell].remove(); markEls[cell] = null; }
      if (!state) return;
      const g = GLYPHS[state === 2 ? 'star' : 'x'];
      const [, , vw, vh] = g.viewBox.split(' ').map(Number);
      const r = Math.floor(cell / n), c = cell % n;
      const group = mk('g', { transform: `translate(${c} ${r}) scale(${1 / vw} ${1 / vh})` }, markLayer);
      for (const p of g.paths) { const name = varName(p.fill); mk('path', { d: p.d, fill: DEFAULT_COLORS[name] || '#8b8b8b' }, group); }
      markEls[cell] = group;
    }
    function drawBg(cell, color) {
      if (bgEls[cell]) { bgEls[cell].remove(); bgEls[cell] = null; }
      if (!color) return;
      const r = Math.floor(cell / n), c = cell % n;
      const hex = (sem.colors[color - 1] || {}).hex || '#ff7868';
      bgEls[cell] = mk('rect', { x: c, y: r, width: 1, height: 1, fill: hex }, bgLayer);
    }
    function drawHilite() {
      hiLayer.innerHTML = '';
      for (let i = 0; i < n * n; i++) if (hil[i]) {
        const r = Math.floor(i / n), c = i % n;
        const L = c > 0 && hil[i - 1], R = c < n - 1 && hil[i + 1], U = r > 0 && hil[i - n], D = r < n - 1 && hil[i + n];
        // one rounded rect per cell, stretched toward highlighted neighbours so a stroke reads as one shape
        const x0 = c + (L ? 0 : 0.1), x1 = c + 1 - (R ? 0 : 0.1), y0 = r + (U ? 0 : 0.1), y1 = r + 1 - (D ? 0 : 0.1);
        mk('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 0.18, fill: HILITE_FILL, 'fill-opacity': 0.55 }, hiLayer);
      }
    }
    function apply(op) {
      if (op.kind === KIND.MARK) { marks[op.cell] = op.state; drawMark(op.cell, op.state); return op.cell; }
      if (op.kind === KIND.BG) { bgs[op.cell] = op.color; drawBg(op.cell, op.color); return op.cell; }
      if (op.kind === KIND.HILITE) { hil = op.cells.slice(); drawHilite(); return null; }
      return null;
    }
    function reset() {
      for (let i = 0; i < n * n; i++) { drawMark(i, 0); drawBg(i, 0); marks[i] = 0; bgs[i] = 0; }
      hil.fill(false); drawHilite();
      for (const op of sem.initial) apply(op);
    }
    function cellRect(cell) {
      const b = svg.getBoundingClientRect(); const unit = b.width / (n + 0.24);
      const r = Math.floor(cell / n), c = cell % n;
      return { left: b.left + (c + 0.12) * unit, top: b.top + (r + 0.12) * unit, width: unit, height: unit };
    }
    reset();
    return { apply, reset, cellRect, svg };
  }

  function describe(op, n) {
    const rc = (cell) => ` r${Math.floor(cell / n) + 1}c${(cell % n) + 1}`;
    if (op.kind === KIND.MARK) return (op.state === 2 ? '★ star' : op.state === 1 ? '✕' : 'cleared') + rc(op.cell);
    if (op.kind === KIND.BG) return (op.color ? 'hint' : 'hint cleared') + rc(op.cell);
    if (op.kind === KIND.HILITE) { const k = op.cells.filter(Boolean).length; return k ? `highlight (${k} cells)` : 'highlights cleared'; }
    if (op.kind === KIND.UI) return op.label;
    if (op.kind === KIND.PAUSE) return 'paused for ' + fmt(op.away);
    return 'changed';
  }
  function fmt(ms) { const s = Math.floor((ms || 0) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  const isMove = (op) => op.kind === KIND.MARK || op.kind === KIND.BG || op.kind === KIND.HILITE;

  return { KIND, fromGeneric, toBytes, fromBytes, encodeFragment, decodeFragment, render, describe, isMove, hiliteCells };
})();
