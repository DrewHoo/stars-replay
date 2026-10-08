# stars-replay

The public replay viewer for recordings made with the Inkwell Replay browser
extension: https://drewhoover.com/stars-replay/

A share link carries a whole recording in its URL fragment (`#r=…`, gzipped
and base64url-encoded), so this is a static site with no backend. Drop a
recording `.json` on the page, or open a share link.

This repo is a deploy target only. The source of truth is the `extension/`
folder of the (not yet published) `inkwell-replay` project; `publish.sh` there
copies the viewer files into `site/` and pushes.
