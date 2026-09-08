import type { CSSProperties, ReactNode, Ref } from 'react';
import type {
  BookSnapshot,
  FlipCorner,
  FlipOptions,
  FlipbookEventMap,
  PageFlip,
  TurnRejected,
  WidgetEvent,
} from '@gullabs/flipbook-core';

export type { WidgetEvent, FlipbookEventMap, BookSnapshot, TurnRejected };

/**
 * `PageState` used to be declared here as a string union AND in core as an
 * unrelated interface, so a consumer importing both got two types with one
 * name. Re-exported from core instead of redeclared.
 */
export type { FlippingState as PageState } from '@gullabs/flipbook-core';

export type PageOrientation = 'portrait' | 'landscape';

/**
 * What is actually on screen when the live region speaks.
 *
 * `pages` holds the leaf indices of the current spread — one in portrait, up to
 * two in landscape — because "the current page" is not a single number for a
 * book showing two leaves at once.
 */
export type LiveRegionInfo = {
  /** Leaf indices of the current spread, in reading order. */
  pages: number[];
  orientation: PageOrientation;
  /** Whether leaf 0 is a cover rather than a numbered page. */
  hardCovers: boolean;
};

export type LiveRegionTextFn = (page: number, pageCount: number, info: LiveRegionInfo) => string;

/**
 * D18. Every handler receives the PAYLOAD, not a `WidgetEvent` wrapper.
 *
 * There used to be three conventions in this one type: `onPageChange` got an
 * unwrapped number, every other handler got a `WidgetEvent` the consumer had to
 * reach into, and `onNavigationError` got a bare object. ADR 0003 identified
 * that asymmetry as *why* consumers bound the wrong event. The engine's `on()`
 * keeps its wrapper; the binding unwraps uniformly.
 *
 * `onFlip` is gone — it and `onPageChange` named one occurrence, and two props
 * for one event is a support burden forever. `onPageChange` is the name that
 * matches what ADR 0003 made the event mean.
 *
 * `onNavigationError` is gone too: it was a React-only fourth channel for a
 * condition the engine already reports through `turnRejected`, and it hardcoded
 * `code: 'INVALID_PAGE'`, discarding the `PAGE_NOT_IN_SPREAD` distinction the
 * core paid for.
 */
export type IEventProps = {
  /** The reader is now on a different page. Never fires for a repaint. */
  onPageChange?: (snapshot: BookSnapshot) => void;
  onChangeOrientation?: (info: FlipbookEventMap['changeOrientation']) => void;
  onChangeState?: (info: FlipbookEventMap['changeState']) => void;
  /** Once per engine. */
  onReady?: (snapshot: BookSnapshot) => void;
  /** Every load, including the first. */
  onLoaded?: (snapshot: BookSnapshot) => void;
  /** The page collection was replaced. */
  onPagesChanged?: (snapshot: BookSnapshot) => void;
  onTurnRejected?: (info: TurnRejected) => void;
  /**
   * Fold progress while a turn or user fold is in flight. Unwrapped payload
   * (`{ progress, direction }`), not a `WidgetEvent`. Never fires for instant
   * turns; completion is `onPageChange` / `onChangeState`, not the last tick.
   */
  onTurnProgress?: (info: FlipbookEventMap['turnProgress']) => void;
};

/**
 * D15. One failure contract.
 *
 * `flipNext`/`flipPrev` returned `boolean` and never threw, while
 * `turnToPage`/`flipToPage` threw after mount and were silent no-ops before it
 * — so the same call was an uncaught throw that took down the React tree, or
 * nothing, depending on timing. Every method now returns `boolean`, and a
 * refusal is reported through `onTurnRejected` like any other. The engine keeps
 * its throw, where the caller can catch it.
 */
export type FlipBookHandle = {
  pageFlip: () => PageFlip | null;
  flipNext: (corner?: FlipCorner) => boolean;
  flipPrev: (corner?: FlipCorner) => boolean;
  /** Jump with no animation. `false` if the engine refused or is not ready. */
  turnToPage: (page: number) => boolean;
  /** Animate to a page. `false` if the engine refused or is not ready. */
  flipToPage: (page: number) => boolean;
  /**
   * Abandon an in-flight turn without committing. `false` before mount, after
   * unmount, when idle, or when the engine is destroyed. Not finish/pause/jump.
   */
  cancelTurn: () => boolean;
  /**
   * Tear down the engine while the component stays mounted. The shell retires
   * in this call (portal dropped, chrome dead, further turns `DESTROYED`).
   * Revival is unmount or a remount-key change (`hardCovers` / `initialPage` /
   * `injectStyles`). Unmount already destroys; you do not need this then.
   *
   * `pageFlip()?.destroy()` tears the engine down but does not retire the
   * React shell until the next render — use this method.
   */
  destroy: () => void;
};

/** How a controlled `page` change moves the book. */
export type PageTransition = 'animate' | 'instant';

export type HTMLFlipBookProps = {
  /** Required page width in CSS pixels. */
  width: number;
  /** Required page height in CSS pixels. */
  height: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  /**
   * Controlled page index. Genuinely controlled: the binding re-asserts it when
   * the ENGINE moves, so `page` without `onPageChange` is a locked book.
   */
  page?: number;
  /**
   * How a controlled `page` change moves the book. Defaults to `'animate'` —
   * in a page-FLIP library, the declarative path opting out of the animation
   * was an undiscoverable surprise. Use `'instant'` for deep links.
   */
  pageTransition?: PageTransition;
  /** Keyboard turning (Arrow/Home/End). Default true. */
  useKeyboard?: boolean;
  /**
   * Render real previous/next buttons inside the book.
   *
   * H4, and it is not a convenience. A screen-reader user in BROWSE mode never
   * receives the arrow keys — the virtual cursor consumes them — and the root
   * deliberately does not use `role="application"`, which would take the
   * virtual cursor away and make linear reading impossible. Without real
   * controls such a reader had no way to turn a page at all.
   *
   * `'auto'` (default) clips them out of the layout but keeps them in the
   * accessibility tree and the tab order, revealing them on focus — the
   * skip-link pattern. Shipping visible buttons by default would change the
   * rendered height of every existing book.
   *
   * `'visible'` puts them in normal flow for you to style. `'none'` removes
   * them — only do that if you render your own, because without controls a
   * browse-mode screen-reader user cannot turn a page at all.
   */
  controls?: 'auto' | 'visible' | 'none';
  /** Labels for the built-in controls. Localise these. */
  controlLabels?: { previous: string; next: string };
  /** Mount only leaves within this many spreads of the current one. */
  lazyRadius?: number;
  /** Accessible name for the book. */
  'aria-label'?: string;
  /**
   * `aria-roledescription` for the book. Localisable: VoiceOver and NVDA
   * substitute it for the role, so a hardcoded English string is worse than
   * none for a book in another language.
   */
  roleDescription?: string;
  /** When false, no live region is rendered. Default true. */
  liveRegion?: boolean;
  liveRegionText?: LiveRegionTextFn;
  ref?: Ref<FlipBookHandle | null>;
} & Omit<FlipOptions, 'width' | 'height'> &
  IEventProps;
