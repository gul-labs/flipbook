# Video-page probe (evidence for VIDEO-PAGES-REQUIREMENTS.md)

Reproduces §1 of [../VIDEO-PAGES-REQUIREMENTS.md](../VIDEO-PAGES-REQUIREMENTS.md)
against the built core. Test clips are generated, not committed.

```bash
pnpm build                                   # fixture imports packages/core/dist
D=docs/requests/video-pages
ffmpeg -f lavfi -i "testsrc2=size=400x520:rate=30" -t 6 -c:v libx264 -pix_fmt yuv420p -an -movflags +faststart $D/silent.mp4
ffmpeg -f lavfi -i "testsrc2=size=400x520:rate=30" -f lavfi -i "sine=frequency=440" -t 6 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart $D/clip.mp4
python3 -m http.server 4199 --bind 127.0.0.1    # leave running in this terminal
```

From another terminal at the repo root, run
`node docs/requests/video-pages/probe.mjs`. It checks Chromium and WebKit,
writes screenshots to `docs/requests/video-pages/out/`, and exits nonzero if
either browser fails. Stop the server with Ctrl-C afterward.

`testsrc2` burns the timecode and frame counter into the picture, so a
fold/page frame mismatch is readable in the screenshots. The `.mp4` files and
`out/` are git-ignored.
