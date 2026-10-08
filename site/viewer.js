// Inkwell Replay — viewer. Rebuilds the board from the recorded base HTML and
// re-applies each recorded slot diff in time order.
(() => {
  const $ = (id) => document.getElementById(id);
  const ext = globalThis.browser || globalThis.chrome;
  const hasChrome = !!(ext && ext.storage && ext.storage.local);
  const MAX_GAP_MS = 3000; // idle stretches longer than this are skipped during playback

  let rec = null;          // the loaded recording
  let baseHtml = '';       // decompressed board root HTML
  let baseRoot = null;     // pristine board root (never mutated)
  let root = null;         // live board root inside #board
  let events = [];         // sorted, with derived labels
  let cursor = 0;          // number of events applied
  let playhead = 0;        // ms into the recording
  let playing = false;
  let rafId = null, lastTick = 0;
  let gridSize = { rows: 0, cols: 0 };
  let mode = 'dom';        // 'dom' replays recorded markup; 'stars' draws its own board
  let sem = null;          // semantic recording (stars mode)
  let board = null;        // StarsCodec.render controller (stars mode)

  // ---------- loading ----------
  async function gunzipBase64(b64) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Response(ds.readable).text();
  }

  // Replay data rides in the query string (so link previews can read it) or,
  // for older links, in the fragment.
  function linkData() {
    const qs = new URLSearchParams(location.search);
    for (const k of ['z', 's', 'r', 'u']) if (qs.get(k)) return k + '=' + qs.get(k);
    const m = location.hash.match(/^#([zsru])=([A-Za-z0-9_-]+)$/);
    return m ? m[1] + '=' + m[2] : null;
  }
  async function loadFromQuery() {
    const data = linkData();
    if (data && /^[sz]=/.test(data)) return { __sem: await StarsCodec.decodeFragment('#' + data) };
    if (data) return data.startsWith('r=') ? InkwellShare.decode(data.slice(2)) : InkwellShare.decodePlain(data.slice(2));
    const qs = new URLSearchParams(location.search);
    if (qs.get('id') && hasChrome) {
      const key = 'rec:' + qs.get('id');
      return (await ext.storage.local.get(key))[key] || null;
    }
    if (qs.get('src')) return (await fetch(qs.get('src'))).json();
    return null;
  }

  async function open(recording) {
    if (recording && recording.__sem) return openSemantic(recording.__sem);
    if (!recording || !recording.base || !recording.events) {
      alert('That file is not an Inkwell Replay recording.');
      return;
    }
    rec = recording;
    mode = 'dom'; sem = null; board = null;
    const html = rec.base.html || (await gunzipBase64(rec.base.htmlGz));
    baseHtml = html;
    const tpl = document.createElement('template');
    tpl.innerHTML = InkwellShare.sanitizeHtml(html);
    baseRoot = tpl.content.firstElementChild;

    const cells = [...baseRoot.querySelectorAll('[data-testid^="puzzle-cell-"]')];
    gridSize = cells.reduce((acc, c) => {
      const [, r, k] = c.dataset.testid.match(/puzzle-cell-(\d+)-(\d+)/) || [];
      return { rows: Math.max(acc.rows, +r + 1 || 0), cols: Math.max(acc.cols, +k + 1 || 0) };
    }, { rows: 0, cols: 0 });

    const stage = $('board');
    for (const [k, v] of Object.entries(rec.palette || {})) stage.style.setProperty('--' + k, v);
    stage.style.width = rec.base.width + 'px';
    stage.style.maxWidth = '100%';
    stage.hidden = false;
    $('drop').hidden = true;
    $('controls').hidden = false;

    events = rec.events
      .map((e, i) => {
        const move = Array.isArray(e[1]);
        return { i, t: e[0], path: move ? e[1] : null, id: move ? e[2] : null,
                 ui: e[1] === 'ui' ? e[2] : e[1] === 'pause' ? 'paused for ' + fmt(e[2]) : null };
      })
      .sort((a, b) => a.t - b.t);
    for (const ev of events) ev.label = describe(ev);
    finishOpen();
  }

  // A compact (semantic) Stars recording: we draw the board ourselves.
  function openSemantic(s) {
    sem = s; mode = 'stars';
    rec = { game: 'stars', date: s.date, startedAt: s.startedAt, duration: s.duration };
    const stage = $('board');
    stage.innerHTML = '';
    stage.style.width = '588px';
    stage.style.maxWidth = '100%';
    stage.hidden = false;
    $('drop').hidden = true;
    $('controls').hidden = false;
    board = StarsCodec.render(stage, s);
    events = s.events.map((op, i) => {
      const label = StarsCodec.describe(op, s.n);
      return { i, t: op.t, op, ui: StarsCodec.isMove(op) ? null : label, label };
    });
    finishOpen();
  }

  function finishOpen() {
    const moves = events.filter((e) => !e.ui).length;
    $('title').textContent = `${cap(rec.game)} · ${rec.date || 'undated'}`;
    $('meta').textContent = `${moves} moves in ${fmt(rec.duration)}` + (rec.startedAt ? ` · recorded ${new Date(rec.startedAt).toLocaleString()}` : '');
    $('count').textContent = `(${moves})`;
    $('total').textContent = fmt(rec.duration);
    $('scrub').max = String(rec.duration || 1);
    document.title = `${cap(rec.game)} ${rec.date || ''} – Stars Replay`;
    renderList();
    reset();
    seekTo(0);
  }

  // ---------- board manipulation ----------
  function elAt(node, path) {
    for (const i of path) node = node && node.children[i];
    return node || null;
  }

  function reset() {
    cursor = 0;
    if (mode === 'stars') { board.reset(); return; }
    const stage = $('board');
    stage.innerHTML = '';
    root = baseRoot.cloneNode(true);
    root.style.width = '100%';
    root.style.margin = '0';
    stage.appendChild(root);
  }

  function applyEvent(ev, flash) {
    if (mode === 'stars') {
      const cell = board.apply(ev.op);
      if (flash && cell !== null && cell !== undefined) flashRect(board.cellRect(cell));
      return;
    }
    if (ev.ui) return;
    const el = elAt(root, ev.path);
    if (!el || !(ev.id in rec.dict)) return;
    el.outerHTML = InkwellShare.sanitizeHtml(rec.dict[ev.id]);
    if (flash) flashEvent(ev);
  }

  function flashEvent(ev) {
    if (!ev || ev.ui) return;
    if (mode === 'stars') { const c = ev.op.cell; if (c !== undefined) flashRect(board.cellRect(c)); return; }
    const el = elAt(root, ev.path || []);
    if (el) flashRect(el.getBoundingClientRect());
  }

  function flashRect(r) {
    const f = $('flash');
    const s = $('board').parentElement.getBoundingClientRect();
    Object.assign(f.style, { left: r.left - s.left - 3 + 'px', top: r.top - s.top - 3 + 'px', width: r.width + 'px', height: r.height + 'px' });
    f.hidden = false;
    f.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
  }

  // Apply events up to time `t`. Rewinds by rebuilding from the base.
  function seekTo(t, flash = false) {
    t = Math.max(0, Math.min(t, rec.duration || 0));
    let target = 0;
    while (target < events.length && events[target].t <= t) target++;
    if (target < cursor) reset();
    while (cursor < target) applyEvent(events[cursor++], flash && cursor === target);
    playhead = t;
    updateUi();
  }

  function stepToEvent(index) {
    index = Math.max(-1, Math.min(index, events.length - 1));
    pause();
    seekTo(index < 0 ? 0 : events[index].t, true);
  }

  // ---------- playback ----------
  function play() {
    if (playing) return;
    if (playhead >= (rec.duration || 0)) seekTo(0);
    playing = true;
    $('play').textContent = '❚❚';
    lastTick = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    $('play').textContent = '▶';
    cancelAnimationFrame(rafId);
  }

  function tick(nowMs) {
    if (!playing) return;
    const speed = +$('speed').value;
    let next = playhead + (nowMs - lastTick) * speed;
    lastTick = nowMs;
    if (cursor < events.length) {
      const gapStart = cursor ? events[cursor - 1].t : 0;
      const nextT = events[cursor].t;
      if (nextT - gapStart > MAX_GAP_MS && next < nextT - MAX_GAP_MS / 2) next = Math.max(next, nextT - MAX_GAP_MS / 2);
    }
    const before = cursor;
    seekTo(next);
    if (cursor > before) flashEvent(events[cursor - 1]);
    if (playhead >= (rec.duration || 0)) return pause();
    rafId = requestAnimationFrame(tick);
  }

  // ---------- describing moves ----------
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

  function fmt(ms) {
    const s = Math.floor((ms || 0) / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function cellOf(path) {
    const el = elAt(baseRoot, path);
    if (!el) return null;
    const m = (el.dataset.testid || '').match(/puzzle-cell-(\d+)-(\d+)/);
    if (m) return { r: +m[1], c: +m[2] };
    if (gridSize.cols && el.style.left.endsWith('%')) {
      return { r: Math.round(parseFloat(el.style.top) * gridSize.rows / 100), c: Math.round(parseFloat(el.style.left) * gridSize.cols / 100) };
    }
    return null;
  }

  function classify(html) {
    if (/fill="var\(--yellow-default\)"/.test(html)) return '★ star';
    if (/viewBox="0 0 43 43"/.test(html) || />✕</.test(html)) return '✕';
    if (/<svg[^>]*preserveAspectRatio/.test(html)) return /<path/.test(html) ? 'highlight' : 'highlights cleared';
    if (/aria-pressed="true"/.test(html)) return 'clue marked';
    if (/aria-pressed="false"/.test(html)) return 'clue unmarked';
    if (/^<[^>]+><\/\w+>$/.test(html)) return 'cleared';
    const bgs = [...html.matchAll(/background-color:\s*var\(--([\w-]+)\)/g)].map((m) => m[1])
      .filter((c) => !/^(white|black|gray-300)$/.test(c));
    if (bgs.includes('purple-default')) return 'filled';
    if (/<svg/.test(html)) return 'mark';
    if (bgs.length) return 'highlight (' + bgs[0] + ')';
    if (/^<[^>]+>(<div[^>]*>)*(<\/div>)*$/.test(html)) return 'cleared';
    return 'changed';
  }

  function describe(ev) {
    if (ev.ui) return ev.ui;
    const what = classify(rec.dict[ev.id] || '');
    const cell = cellOf(ev.path);
    const where = cell ? ` r${cell.r + 1}c${cell.c + 1}` : '';
    return what + where;
  }

  function renderList() {
    const list = $('list');
    list.innerHTML = '';
    events.forEach((ev, i) => {
      const li = document.createElement('li');
      li.className = ev.ui ? 'ui' : '';
      li.innerHTML = `<span class="t">${fmt(ev.t)}</span><span class="what"></span>`;
      li.querySelector('.what').textContent = ev.label;
      li.addEventListener('click', () => stepToEvent(i));
      list.appendChild(li);
    });
  }

  function updateUi() {
    $('scrub').value = String(playhead);
    $('now').textContent = fmt(playhead);
    const items = $('list').children;
    for (let i = 0; i < items.length; i++) {
      items[i].classList.toggle('current', i === cursor - 1);
      items[i].classList.toggle('done', i < cursor - 1);
      items[i].classList.toggle('future', i >= cursor);
    }
    const cur = items[cursor - 1];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  // ---------- wiring ----------
  $('play').addEventListener('click', () => (playing ? pause() : play()));
  $('first').addEventListener('click', () => stepToEvent(-1));
  $('last').addEventListener('click', () => stepToEvent(events.length - 1));
  $('back').addEventListener('click', () => stepToEvent(cursor - 2));
  $('fwd').addEventListener('click', () => stepToEvent(cursor));
  $('scrub').addEventListener('input', (e) => { pause(); seekTo(+e.target.value); });
  document.addEventListener('keydown', (e) => {
    if (!rec) return;
    const t = e.target;
    const typing = t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'range');
    if (typing) return;
    if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepToEvent(cursor); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stepToEvent(cursor - 2); }
    else if (e.key === 'Home') { e.preventDefault(); stepToEvent(-1); }
    else if (e.key === 'End') { e.preventDefault(); stepToEvent(events.length - 1); }
  });

  // Prefer the compact Stars fragment; fall back to the generic DOM payload.
  async function shareFragment() {
    if (mode === 'stars') return StarsCodec.encodeFragment(sem);
    try {
      const s = StarsCodec.fromGeneric(rec, baseHtml);
      if (s && s.skipped === 0) return StarsCodec.encodeFragment(s);
    } catch (err) { console.warn('compact encoding failed', err); }
    return InkwellShare.fragment(rec, baseHtml);
  }

  $('share').addEventListener('click', async () => {
    if (!rec) return;
    const base = (typeof INKWELL_REPLAY_CONFIG !== 'undefined' && INKWELL_REPLAY_CONFIG.PUBLIC_VIEWER_URL) || location.origin + location.pathname;
    const url = base + '?' + await shareFragment();
    try {
      await navigator.clipboard.writeText(url);
      toast(`Link copied · ${(url.length / 1000).toFixed(1)}k characters`);
    } catch (err) {
      prompt('Copy this link:', url);
    }
  });

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.hidden = true), 2500);
  }

  $('load').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) open(JSON.parse(await file.text()));
    e.target.value = '';
  });
  const drop = $('drop');
  for (const evName of ['dragenter', 'dragover']) document.addEventListener(evName, (e) => { e.preventDefault(); drop.classList.add('over'); });
  document.addEventListener('dragleave', () => drop.classList.remove('over'));
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) open(JSON.parse(await file.text()));
  });

  loadFromQuery().then((r) => r && open(r)).catch((err) => { console.error(err); });
  window.__viewer = { shareFragment, get mode() { return mode; }, get sem() { return sem; }, get rec() { return rec; } };
})();
