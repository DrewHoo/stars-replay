// Share-link encoding shared by content.js and viewer.js.
// A share link carries the whole recording in the URL fragment, gzipped and
// base64url-encoded, so a static page can replay it with no backend.
const InkwellShare = (() => {
  async function gzip(str) {
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    w.write(new TextEncoder().encode(str));
    w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  async function gunzip(bytes) {
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    w.write(bytes);
    w.close();
    return new Response(ds.readable).text();
  }
  function toB64(bytes, url) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const b = btoa(bin);
    return url ? b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b;
  }
  function fromB64(b64) {
    const s = b64.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
  }
  // rec.base.html must be present (not just htmlGz) so the whole payload is
  // compressed once rather than base64-inside-gzip.
  async function encode(rec, baseHtml) {
    const payload = { ...rec, base: { ...rec.base, html: baseHtml } };
    delete payload.base.htmlGz;
    return toB64(await gzip(JSON.stringify(payload)), true);
  }
  async function decode(fragment) {
    return JSON.parse(await gunzip(fromB64(fragment)));
  }
  // Recordings can arrive from anyone's share link, so everything we re-render
  // is filtered through a strict allowlist: the handful of tags and attributes
  // the inkwellgames.com board actually uses. Scripts, event handlers and
  // url() references never make it to the page.
  const SAFE_TAGS = new Set(['div', 'span', 'button', 'svg', 'g', 'path', 'line', 'rect', 'circle', 'polyline', 'polygon', 'text', 'defs', 'clippath', 'use']);
  const SAFE_ATTRS = new Set(['style', 'class', 'id', 'type', 'viewbox', 'preserveaspectratio', 'xmlns', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'transform', 'clip-path']);
  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString('<body>' + html, 'text/html');
    const walk = (node) => {
      for (const child of [...node.children]) {
        const tag = child.tagName.toLowerCase();
        if (!SAFE_TAGS.has(tag)) { child.remove(); continue; }
        for (const attr of [...child.attributes]) {
          const name = attr.name.toLowerCase();
          const ok = SAFE_ATTRS.has(name) || name.startsWith('data-') || name.startsWith('aria-');
          const bad = /url\s*\(|javascript:|expression\s*\(/i.test(attr.value) || name.startsWith('on');
          if (!ok || bad) child.removeAttribute(attr.name);
        }
        walk(child);
      }
    };
    walk(doc.body);
    return doc.body.innerHTML;
  }
  function link(viewerUrl, encoded) {
    return viewerUrl + '#r=' + encoded;
  }
  return { gzip, gunzip, toB64, fromB64, encode, decode, link, sanitizeHtml };
})();
