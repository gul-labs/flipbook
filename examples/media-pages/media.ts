/**
 * Host-owned media policy for a flipbook — the recipe `docs/MEDIA-PAGES.md`
 * documents. Copy it; it is not part of the library.
 *
 * The engine never plays, pauses, seeks or reloads your media (ADR 0004). It
 * tells you when a turn starts and which pages are on screen; this module turns
 * that into playback:
 *
 * - **Turn start** (`changeState` → `user_fold` / `flipping`): pause every
 *   AUDIBLE `<video>` / `<audio>` on the pages being turned. This runs before
 *   the engine copies a portrait leaf, so the fold shows the paused frame.
 *   Muted loops keep running; the fold copy freezes their frame on its own.
 * - **Turn abandoned** (`read` with no `flip` since the turn started — a
 *   snap-back, `cancelTurn()`, an OS pointer cancel): resume exactly what the
 *   turn paused. The reader did not leave the page.
 * - **Page change** (`flip`, `changeOrientation`, `pagesChanged`): pause
 *   everything, muted loops and embeds included, on pages that left the
 *   screen, so a hidden page stops decoding (R-6). `turnToPage` jumps have no
 *   turn and no `changeState`, so this is also what covers them.
 * - **Arrival**: start muted decorative loops (`muted` + `loop`) on pages that
 *   came on screen, unless the reader prefers reduced motion. Nothing with
 *   sound ever starts on its own (WCAG 1.4.2, browser autoplay policy).
 */
import type { PageFlip } from '@gullabs/flipbook-core';

export interface MediaPolicyOptions {
  /** Start `muted loop` media when its page arrives. Default `true`. */
  autoplayMutedLoops?: boolean;
}

/** YouTube / Vimeo accept a `pause` command over `postMessage`. */
const EMBED_PAUSE: ReadonlyArray<[RegExp, string]> = [
  [
    /^https:\/\/www\.youtube(-nocookie)?\.com$/,
    JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }),
  ],
  [/^https:\/\/player\.vimeo\.com$/, JSON.stringify({ method: 'pause' })],
];

function mediaIn(root: ParentNode): HTMLMediaElement[] {
  return Array.from(root.querySelectorAll<HTMLMediaElement>('video, audio'));
}

function isAudible(media: HTMLMediaElement): boolean {
  // A MediaStream without an audio track, or a file with none, is silent too,
  // but only `muted` / `volume` are cheap and portable to read.
  return !media.muted && media.volume > 0;
}

/**
 * Ask YouTube / Vimeo players on `root` to pause. YouTube needs
 * `enablejsapi=1` on the embed URL; without it the message is ignored. The
 * target origin is always the frame's exact origin, never `'*'`.
 */
export function pauseEmbeds(root: ParentNode): void {
  for (const frame of Array.from(root.querySelectorAll<HTMLIFrameElement>('iframe[src]'))) {
    let origin: string;
    try {
      origin = new URL(frame.src).origin;
    } catch {
      continue;
    }
    const command = EMBED_PAUSE.find(([pattern]) => pattern.test(origin))?.[1];
    if (command !== undefined) frame.contentWindow?.postMessage(command, origin);
  }
}

export function attachMediaPolicy(book: PageFlip, options: MediaPolicyOptions = {}): () => void {
  const autoplayMutedLoops = options.autoplayMutedLoops ?? true;
  const reducedMotion =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  let shown = book.getVisiblePages();
  let turning = false;
  let turned = false;
  const pausedByTurn = new Set<HTMLMediaElement>();

  const leaves = (indices: readonly number[]): HTMLElement[] =>
    indices.map((i) => book.getPageElement(i)).filter((el): el is HTMLElement => el !== null);

  const startLoops = (pages: readonly number[]): void => {
    if (!autoplayMutedLoops || reducedMotion?.matches === true) return;
    for (const leaf of leaves(pages)) {
      for (const media of mediaIn(leaf)) {
        if (media.muted && media.loop && media.paused) {
          // Rejected when the platform refuses (Low Power Mode, a WebView that
          // requires a gesture). The poster stays up; nothing to recover.
          media.play().catch(() => {});
        }
      }
    }
  };

  const onChangeState = ({ data }: { data: { state: string } }): void => {
    if (data.state === 'user_fold' || data.state === 'flipping') {
      if (turning) return;
      turning = true;
      turned = false;
      for (const leaf of leaves(shown)) {
        for (const media of mediaIn(leaf)) {
          if (!media.paused && isAudible(media)) {
            media.pause();
            pausedByTurn.add(media);
          }
        }
      }
      return;
    }
    if (data.state !== 'read') return;

    // `fold_corner` (a hover peel) is not a turn: pausing on every hover
    // would stop the video under the reader's mouse.
    if (turning && !turned) {
      for (const media of pausedByTurn) {
        // Resuming media the reader already started is allowed once the page
        // has had a user gesture; if the platform refuses, it stays paused.
        if (media.isConnected) media.play().catch(() => {});
      }
    }
    pausedByTurn.clear();
    turning = false;
  };

  const reconcile = (): void => {
    turned = true;
    const now = book.getVisiblePages();
    const left = shown.filter((i) => !now.includes(i));
    const arrived = now.filter((i) => !shown.includes(i));
    for (const leaf of leaves(left)) {
      for (const media of mediaIn(leaf)) if (!media.paused) media.pause();
      pauseEmbeds(leaf);
    }
    shown = now;
    startLoops(arrived);
  };

  book.on('changeState', onChangeState);
  book.on('flip', reconcile);
  book.on('changeOrientation', reconcile);
  book.on('pagesChanged', reconcile);
  startLoops(shown);

  return () => {
    book.off('changeState', onChangeState);
    book.off('flip', reconcile);
    book.off('changeOrientation', reconcile);
    book.off('pagesChanged', reconcile);
    pausedByTurn.clear();
  };
}
