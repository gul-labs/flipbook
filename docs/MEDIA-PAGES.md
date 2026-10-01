# Media pages — video, audio and embeds in a flipbook

A leaf can hold `<video>`, `<audio>`, `<iframe>` (YouTube, Vimeo), `<embed>`
and `<object>`. This page says what the engine does with them during a turn,
what it deliberately leaves to you, and how to wire playback correctly.

Working code: [`examples/media-pages`](../examples/media-pages) (vanilla; the
recipe is [`media.ts`](../examples/media-pages/media.ts)) and
[`examples/vite-react/src/MediaBook.tsx`](../examples/vite-react/src/MediaBook.tsx)
(React, same recipe). [`e2e/media-pages.spec.ts`](../e2e/media-pages.spec.ts)
runs the recipe against the real engine in Chromium and WebKit. The decision
record is [ADR 0004](./adr/0004-media-pages.md).

## What the engine does

| Situation                                  | Engine behaviour                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portrait soft turn                         | The leaf is copied for the fold ([LIVE-PAGE-FACES.md](./LIVE-PAGE-FACES.md)). In the copy, a `<video>` becomes a `<canvas data-stf-frame>` showing what the page shows (the poster until the video has played, else the current frame); `<audio>`, `<iframe>`, `<embed>`, `<object>` become an empty `<div data-stf-embed>` with the same box. The copy never loads, decodes or plays anything. |
| Landscape spread turn, hard page           | Nothing is copied. The live leaf folds; its media keeps playing unless you pause it.                                                                                                                                                                                                                                                                                                            |
| Pointer down on media                      | With `respectInteractiveContent` (default), a gesture that starts on `video[controls]`, `audio[controls]`, `iframe`, `embed` or `object` does not start a fold. A `<video>` without controls still turns like paper.                                                                                                                                                                            |
| Your media elements                        | **Never touched.** The engine does not call `play`, `pause`, `load` or set `currentTime` on anything it did not create.                                                                                                                                                                                                                                                                         |
| `respectReducedMotion` / `flippingTime: 0` | Makes the **turn** instant. It does not pause, mute or replace page content.                                                                                                                                                                                                                                                                                                                    |

## What the engine does not do, and why

The engine sends no pause, and has no `mediaPolicy` setting. That is a
decision ([ADR 0004](./adr/0004-media-pages.md)), not a gap:

- Playback policy is product policy: whether a narrated clip resumes, whether a
  loop restarts, what autoplays on a phone, and what WCAG requires of your
  controls all depend on your content.
- Third-party players (YouTube, Vimeo) are controlled through unversioned
  vendor `postMessage` protocols. A zero-dependency engine cannot own them.
- Page-turn and carousel libraries converge on this split. Swiper leaves
  pausing to the host's `slideChange` handler; 3D FlipBook and FlipHTML5 make
  play-on-show / pause-on-hide an opt-in per element. Only tools that own the
  whole page (Reveal.js) pause by default.

What the engine does provide is the timing: the signals below arrive early
enough that a host pause lands before the fold copy is taken.

## Events and their timing

| Signal                                            | When                                                                           | Use it to                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `changeState` → `user_fold` / `flipping`          | A turn starts. Dispatched synchronously **before** the portrait copy is taken. | Pause audible media on the pages being turned.           |
| `changeState` → `fold_corner`                     | A hover peel (desktop, `foldCornerOnHover`). Also before its copy.             | Usually nothing: pausing on every hover is hostile.      |
| `flip`                                            | The page index changed (turns and `turnToPage` jumps; ADR 0003).               | Pause everything on pages that left `getVisiblePages()`. |
| `changeState` → `read` with no `flip` since start | The turn was abandoned: snap-back, `cancelTurn()`, OS pointer cancel, resize.  | Resume what the turn paused.                             |
| `changeOrientation`, `pagesChanged`               | The set of visible pages may have changed without a turn.                      | Re-check visibility.                                     |

`turnToPage` / `turnToNextPage` jump without a turn, so no `changeState`
fires. Reconciling on `flip` covers them. A hover peel copies the leaf at
`fold_corner`, and a drag that continues from it announces `user_fold` with
the copy already present; the copy then shows the frame from the hover.

## The recipe

[`examples/media-pages/media.ts`](../examples/media-pages/media.ts) is the
whole policy (about 150 lines, no dependencies). Copy it.

```ts
import { attachMediaPolicy } from './media';

const book = new PageFlip(root, {/* … */});
book.loadFromHTML(pages);
const detach = attachMediaPolicy(book); // call detach() before book.destroy()
```

It implements:

- **Turn start:** pause every audible `<video>` / `<audio>` on the visible
  pages. Muted loops keep running; the fold copy freezes their frame.
- **Turn abandoned:** resume exactly what the turn paused.
- **Page change:** pause everything on pages that left the screen (so a hidden
  page stops decoding), including YouTube / Vimeo embeds via `postMessage`.
- **Arrival:** start `muted loop` media on pages that came on screen, unless the
  reader prefers reduced motion. Nothing with sound starts on its own.

React: attach it in `onReady` and detach on unmount
([`MediaBook.tsx`](../examples/vite-react/src/MediaBook.tsx)):

```tsx
<HTMLFlipBook
  ref={book}
  onReady={() => {
    detach.current?.();
    const engine = book.current?.pageFlip();
    detach.current = engine ? attachMediaPolicy(engine) : null;
  }}
>
```

## Authoring media leaves

- **Decorative loop** (living illustration, animated cover):
  `<video muted loop playsinline preload="metadata" poster="still.jpg">`. No
  `autoplay` attribute — the recipe starts it when its page is on screen, so a
  32-page book does not run 32 decoders. The poster is the reduced-motion and
  print fallback.
- **Clip with sound:** `<video controls playsinline preload="metadata">` plus a
  `<track kind="captions">`. The reader starts it. Controls also keep drags on
  the player from turning the page.
- **iPhone:** without `playsinline` a video goes fullscreen on play. Only muted
  or silent video may start without a gesture; Low Power Mode refuses even
  that (the recipe's `play()` rejection is ignored, the poster stays).
- **WebViews:** `WKWebView` needs `allowsInlineMediaPlayback`, and
  `mediaTypesRequiringUserActionForPlayback` decides what may autoplay;
  Android `WebView` has `setMediaPlaybackRequiresUserGesture`.
- **Accessibility:** audio that plays automatically for more than 3 seconds
  needs a pause control (WCAG 2.2 SC 1.4.2); motion that starts automatically
  and lasts more than 5 seconds needs pause/stop/hide (SC 2.2.2). The engine's
  copy is `inert` and `aria-hidden`, so it never adds a second control or a
  second caption cue.
- **Source size:** serve a rendition near the box size × device pixel ratio. A
  leaf is a few hundred CSS pixels wide; a 4K source costs decode power the
  reader never sees, and the portrait copy's frame snapshot costs more the
  larger the source (see Performance).

## YouTube and Vimeo

Yes, you can embed them. Use the player's embed URL in an `<iframe>`:

```js
const url = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
url.searchParams.set('enablejsapi', '1'); // lets the host pause it via postMessage
url.searchParams.set('playsinline', '1'); // stay in the page on iPhone
url.searchParams.set('origin', location.origin);
frame.src = url.href;
frame.allow = 'autoplay; encrypted-media; picture-in-picture';
```

Caveats:

- **Turning:** pointer events inside a cross-origin frame never reach the
  page, and `iframe` is in the interactive selector, so a drag cannot start on
  the player. Readers turn from the margins, corners, keyboard or your buttons.
  A drag that starts outside and crosses the frame keeps working (the engine
  holds pointer capture).
- **Portrait fold:** the copy shows an empty box where the player is (loading
  a second player is what the copy exists to avoid). Give the iframe a
  `background` (a thumbnail) in its style if the blank box matters; the box
  copies the iframe's resolved style.
- **Landscape fold:** the live iframe folds with the leaf and keeps playing.
- **Pausing:** `pauseEmbeds()` in the recipe posts
  `{"event":"command","func":"pauseVideo"}` to YouTube and `{"method":"pause"}`
  to Vimeo, to the frame's exact origin. YouTube ignores it without
  `enablejsapi=1`.
- **Autoplay:** hosted players autoplay only muted (`mute=1`) and only with
  `allow="autoplay"`; on phones, commercial flipbook tools document that it
  generally does not autoplay at all.
- **Privacy:** `youtube-nocookie.com` defers cookies until play, but loading
  the frame still contacts Google. Under GDPR use a consent gate or
  click-to-load (show a thumbnail, insert the iframe on tap). Vimeo: add
  `dnt=1`.
- **Size:** YouTube requires a player of at least 200×200 CSS px.
- **Referrer:** keep the default referrer policy. `referrerpolicy="no-referrer"`
  makes YouTube refuse to play (error 153, "Video player configuration error"),
  so a `WKWebView` loading the book from `file://` or a custom scheme needs an
  https `baseURL`.
- **CSP:** allow `frame-src https://www.youtube-nocookie.com` (and
  `https://player.vimeo.com`).
- **Thumbnail on the portrait fold:** the stand-in box keeps the iframe's
  `class` and `data-*`, so a rule such as
  `[data-stf-clone] [data-stf-embed].yt { background: url(thumb.jpg) center / cover }`
  fills the blank box.
- **Many embeds:** a hidden player keeps its document alive. For a long book,
  set far-away iframes to `about:blank` and restore `src` as they approach.
- **Full-page players:** a leaf filled edge to edge by `video[controls]` or an
  iframe cannot be turned by pointer (every corner lands on the player). Leave
  a margin, or give the reader buttons / keyboard turns.

## Performance

- **Hidden pages:** pause media on pages that leave the screen (the recipe
  does). Every playing `<video>` is a decoder, visible or not.
- **Portrait turn start:** the copy paints the video's current frame
  synchronously. Measured in Chromium (headless): about 2.5 ms for a 1080p
  source and 8 ms for 4K at DPR 1, 15 ms for 4K at DPR 3; WebKit reports about
  1 ms synchronously and dropped one frame in twenty turn starts with a 4K
  source. The canvas is sized to the box × DPR, so memory stays small; the
  cost is reading the source frame, which scales with the source resolution.
  Asynchronous `createImageBitmap` and WebCodecs `VideoFrame` were measured
  and do not remove it ([ADR 0004](./adr/0004-media-pages.md)). **Serve a
  rendition near the box size × device pixel ratio.**
- **Media-free leaves** pay nothing: the copy only scans for media when the
  leaf has some.

## Limitations

- A cloned `<canvas>` is blank (pixels are not copied).
- Media inside a shadow root, or started by a custom element when it is
  connected, is not frozen in the copy.
- The fold shows the frame at the moment the copy was taken; the original keeps
  playing underneath for the length of the turn.

## Sources

- Chrome autoplay policy — https://developer.chrome.com/blog/autoplay
- WebKit, video policies for iOS — https://webkit.org/blog/6784/new-video-policies-for-ios/
- WCAG 2.2 SC 1.4.2 Audio Control — https://www.w3.org/WAI/WCAG22/Understanding/audio-control.html
- WCAG 2.2 SC 2.2.2 Pause, Stop, Hide — https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
- YouTube IFrame Player API — https://developers.google.com/youtube/iframe_api_reference
- Vimeo Player SDK — https://developer.vimeo.com/player/sdk/basics
- Reveal.js media — https://revealjs.com/media/
- Swiper API — https://swiperjs.com/swiper-api
- 3D FlipBook (YouTube pause-on-hide) — https://3dflipbook.net/question?id=2234
- FlipHTML5 video elements — https://help.fliphtml5.com/docs/add-video-elements/
- FlippingBook video — https://flippingbook.com/help/online/changing-your-publication/video-in-depth
