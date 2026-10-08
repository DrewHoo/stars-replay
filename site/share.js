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
  function link(viewerUrl, encoded) {
    return viewerUrl + '#r=' + encoded;
  }
  return { gzip, gunzip, toB64, fromB64, encode, decode, link };
})();
