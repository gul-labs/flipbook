---
'@gullabs/flipbook-core': patch
'@gullabs/react-flipbook': patch
---

Portrait fold copy and controlled `page` fixes.

Core: the portrait fold copy no longer becomes a second player. Copied `<video>` / `<audio>` are silenced and `<video>` is shown as a canvas of what the page shows (poster until played, else the current frame, with the video's resolved layout); `<audio>`, `<iframe>`, `<embed>` and `<object>` become empty boxes of the same size. This includes a media element that is itself the page element. `changeState` (`user_fold` / `flipping`) is emitted before the copy is taken and `read` after it is removed, including on `cancelTurn()`, an OS pointer cancel and a completed turn (the copy also leaves before `flip`). A turn started while the previous copy is settling keeps its own copy. Pointer gestures that start on `video[controls]`, `audio[controls]`, `iframe`, `embed` or `object` do not start a fold. A refused turn over a live drag or hover peel returns to `read`; `turnToPage` from a turn-setup listener supersedes that turn; portrait `flipToPage(n)` curls the leaf on screen; the engine block rule now sets `-webkit-touch-callout: none`. See MIGRATION.md and docs/MEDIA-PAGES.md.

React: a controlled `page` change animates with inline children, settles on the newest value without `onPageChange` stepping backwards, a change made mid-turn starts a fresh animation instead of snapping, is re-issued after the engine abandons it (live resize), and `lazyRadius` placeholders keep the page's `className` / `style` so the engine's classes survive.
