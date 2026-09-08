'use client';

import {
  Children,
  cloneElement,
  createElement,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  FlipCorner,
  PageFlip,
  PageFlipError,
  type FlipOptions,
  type LiveSetting,
  type WidgetEvent,
  type FlipbookEventMap,
} from '@gullabs/flipbook-core';
import { createPortal } from 'react-dom';
import type { FlipBookHandle, HTMLFlipBookProps, LiveRegionInfo, PageOrientation } from './types';

const ENGINE_SETTING_KEYS = [
  'initialPage',
  'sizing',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'drawShadow',
  'flippingTime',
  'usePortrait',
  'startZIndex',
  'autoSize',
  'maxShadowOpacity',
  'hardCovers',
  'allowTouchScroll',
  'respectInteractiveContent',
  'pointerInput',
  'swipeDistance',
  'foldCornerOnHover',
  'flipOnClick',
  'pageBackground',
  'respectReducedMotion',
  'readingDirection',
  // C5: construction-time — it also sits in `remountKeyOf`, so a change
  // rebuilds the engine rather than silently no-opping, and the settings
  // effect never pushes it (the engine would warn and drop it anyway).
  'injectStyles',
] as const satisfies readonly (keyof FlipOptions)[];

/**
 * MIN-4. Undefined means "back to the default", not "leave it as it was".
 *
 * `updateSettings` merges into the engine's authored object, so dropping
 * undefined keys latched the last value forever:
 * `drawShadow={cond ? false : undefined}` stayed `false` for the life of the
 * engine once `cond` had been true once. Conditional props are ordinary React,
 * and a prop that cannot be un-set is a trap.
 *
 * So an absent key is sent EXPLICITLY as `undefined`, and `Settings.resolve`
 * drops undefined values against the defaults — which is what `definedOnly`
 * there is for. The constructor path is unaffected: a fresh engine has no
 * previous value to latch.
 */
function pickSettings(props: HTMLFlipBookProps, forUpdate = false): FlipOptions {
  const out: FlipOptions = {
    width: props.width,
    height: props.height,
  };
  const bag = out as unknown as Record<string, unknown>;

  for (const key of ENGINE_SETTING_KEYS) {
    const value = props[key];
    if (value !== undefined) bag[key] = value;
    else if (forUpdate) bag[key] = undefined;
  }
  return out;
}

/**
 * Settings the engine can only read at construction.
 *
 * `width` / `height` are deliberately NOT here: they are stamped onto the host
 * element and recalculated by `updateSettings`, so a responsive book restyles
 * instead of rebuilding. Keying on them destroyed and recreated the engine on
 * every resize step, losing the current page and any in-flight turn.
 */
function remountKeyOf(props: HTMLFlipBookProps): string {
  // D6. `initialPage` is here now. It is read once, by `attachMode`, so a
  // change to it could never take effect — and the settings effect did not list
  // it as a dependency, so changing it ALONE did nothing while changing it
  // alongside any live prop produced a console warning naming an engine method
  // the consumer never called. Two layers disagreeing by accident of a
  // dependency array. Remounting is the honest reading of "open at a different
  // page".
  // `sizing` is NOT here. It is in `LiveSetting` and `updateSettings`
  // recalculates layout for it, so keying on it destroyed the engine — losing
  // the current page and any in-flight turn — for a change the engine can
  // absorb. That is the exact cost this function's docblock explains that
  // `width`/`height` avoid.
  // `injectStyles` is construction-time too (C5): styles are injected at
  // load, so the only honest reading of a change is a rebuild.
  return [props.hardCovers, props.initialPage, props.injectStyles].join(':');
}

/**
 * The live region announces turns to screen readers, so it must not paint.
 * Styles are inline rather than in FLIPBOOK_CSS because the region is rendered
 * server-side too, before the engine has injected any stylesheet.
 */
/**
 * R-7. The default for the H4 controls: reachable, but no layout impact.
 *
 * Shipping two unstyled buttons in normal flow changes the rendered height of
 * every existing book, and the only escape a consumer had was `controls:
 * false`, which re-opens the accessibility hole the buttons exist to close.
 * That is a bad trade to hand someone.
 *
 * So the default is the skip-link pattern: clipped out of the layout, still in
 * the accessibility tree and still in the tab order, and — via
 * `:focus-within` in the injected stylesheet — visible the moment a keyboard
 * user reaches them. A screen-reader user finds them either way, because
 * clipping does not remove an element from the accessibility tree the way
 * `display: none` does.
 *
 * `controls="visible"` opts into ordinary flow for a consumer who wants
 * pointer-visible buttons and will style them.
 */
const VISUALLY_HIDDEN_UNTIL_FOCUS: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

/** Reference comparison: React reuses DOM nodes for keyed children. */
function sameNodes(previous: HTMLElement[] | null, next: HTMLElement[]): boolean {
  if (previous?.length !== next.length) return false;

  return previous.every((node, index) => node === next[index]);
}

/**
 * Human label for a leaf.
 *
 * This is the leaf index plus one, which is the printed page number only for a
 * book with no front matter (H5.3). The seam for real labels is here: when the
 * owner decides on a public page-label API, this is the one place that has to
 * consult it — `defaultLiveText` never does the arithmetic itself.
 */
function pageLabel(index: number): string {
  return String(index + 1);
}

function defaultLiveText(page: number, pageCount: number, info?: LiveRegionInfo): string {
  if (pageCount <= 0) return 'Book';

  const visible = info && info.pages.length > 0 ? info.pages : [page];
  const first = visible[0] ?? page;
  const second = visible[1];

  // With a cover, leaf 0 is not "page 1" — it is the front of the book, and the
  // final lone leaf is its back.
  if (info?.hardCovers === true && second === undefined) {
    if (first === 0) return 'Front cover';
    if (pageCount > 1 && first === pageCount - 1) return 'Back cover';
  }

  if (second !== undefined) {
    return `Pages ${pageLabel(first)} and ${pageLabel(second)} of ${pageCount}`;
  }

  return `Page ${pageLabel(first)} of ${pageCount}`;
}

type PageRef = ((el: HTMLElement | null) => void) | { current: HTMLElement | null } | null;

/**
 * Keep the consumer's own ref on a page element working: the engine needs the
 * node too, so both refs are called.
 */
function composeRefs(
  collect: (el: HTMLElement | null) => void,
  existing: PageRef,
): (el: HTMLElement | null) => void {
  if (!existing) return collect;

  return (el) => {
    collect(el);

    if (typeof existing === 'function') {
      existing(el);
    } else {
      existing.current = el;
    }
  };
}

/** Stable identity: a literal here would re-run the effect every render. */
const EMPTY_ANCHORS: number[] = [0];

function wrapChildren(
  children: ReactNode,
  visiblePages: number[],
  lazyRadius: number | undefined,
  collect: (index: number) => (el: HTMLElement | null) => void,
): ReactElement[] {
  const list: ReactElement[] = [];

  // `lazyRadius` is documented in SPREADS, but the window used to be measured
  // in pages from the spread HEAD. In landscape that is off by a whole leaf:
  // with `lazyRadius={1}` on spread [2, 3], page 4 sits at distance 2 and page
  // 5 at distance 3, so BOTH leaves of the very next spread were still
  // placeholders while the turn to them animated — the reader watched blank
  // paper turn over.
  //
  // Measuring from the nearest VISIBLE page, with the radius scaled by the
  // pages that spread actually shows, makes one radius mean one spread in both
  // orientations. Portrait is unchanged: one visible page, scale of 1.
  const pagesPerSpread = Math.max(1, visiblePages.length);
  const reach = lazyRadius !== undefined ? lazyRadius * pagesPerSpread : 0;
  const anchors = visiblePages.length > 0 ? visiblePages : [0];

  Children.forEach(children, (child, index) => {
    const far =
      lazyRadius !== undefined && Number.isFinite(lazyRadius)
        ? Math.min(...anchors.map((page) => Math.abs(index - page))) > reach
        : false;

    // One identity per leaf, whether or not it is currently inside the lazy
    // window. Keying placeholders `lazy-${index}` gave the same leaf two
    // different identities, so crossing the window boundary UNMOUNTED and
    // REMOUNTED its DOM node — `sameNodes` compares node references, so the
    // load effect then rebuilt the whole PageCollection on every turn, which
    // is precisely the mid-animation teardown the reference check exists to
    // prevent.
    const keyed = isValidElement(child) ? child : null;
    const key = keyed?.key ?? `page-${index}`;

    if (far) {
      // Same element TYPE as the real page too, for the same reason: React
      // replaces the node when the type changes, even under a stable key. The
      // placeholder carries none of the page's own props, so its content stays
      // unmounted — which is the point of lazy mounting. A component child has
      // no host type to match, so that case still remounts; the escape is to
      // give the page a host element of its own.
      const type = typeof keyed?.type === 'string' ? keyed.type : 'div';

      list.push(
        createElement(type, {
          key,
          'data-flipbook-lazy': '1',
          'aria-hidden': 'true',
          ref: collect(index),
        }),
      );
      return;
    }

    if (!isValidElement(child)) {
      list.push(
        <div key={key} ref={collect(index)}>
          {child}
        </div>,
      );
      return;
    }

    const element = child as ReactElement<{ ref?: PageRef }> & { ref?: PageRef };

    list.push(
      cloneElement(element, {
        key,
        ref: composeRefs(collect(index), element.props.ref ?? element.ref ?? null),
      }),
    );
  });
  return list;
}

export const HTMLFlipBook = forwardRef<FlipBookHandle | null, Omit<HTMLFlipBookProps, 'ref'>>(
  function HTMLFlipBook(props, ref) {
    const {
      children,
      className,
      style,
      page: controlledPage,
      onPageChange,
      onChangeOrientation,
      onChangeState,
      onReady,
      onLoaded,
      onPagesChanged,
      onTurnRejected,
      onTurnProgress,
      pageTransition = 'animate',
      controls = 'auto',
      controlLabels = { previous: 'Previous page', next: 'Next page' },
      useKeyboard = true,
      lazyRadius,
      liveRegion = true,
      liveRegionText = defaultLiveText,
      // Localisable: VoiceOver and NVDA substitute this for the role, so a
      // hardcoded English string is worse than none for a non-English book.
      roleDescription = 'book',
      'aria-label': ariaLabel = 'Flipbook',
    } = props;

    const rootRef = useRef<HTMLDivElement>(null);
    const engineRef = useRef<PageFlip | null>(null);
    const onPagesChangedHold = useRef(onPagesChanged);
    onPagesChangedHold.current = onPagesChanged;
    /**
     * One slot per child, by INDEX. `null` after commit means that child never
     * called its ref — see the children effect.
     */
    const slotsRef = useRef<Array<HTMLElement | null>>([]);
    const childCount = useRef(0);
    /** Monotonic stamp; `pages.gen` matches once the filling commit has run. */
    const slotGeneration = useRef(0);

    /**
     * The page nodes, or a thrown error naming the child that could not be
     * reffed. Never a SHORTER list: a short list is the silent misalignment
     * this exists to make impossible.
     */
    const readNodes = useCallback((): HTMLElement[] => {
      const slots = slotsRef.current;
      const missing: number[] = [];
      const nodes: HTMLElement[] = [];

      for (let i = 0; i < childCount.current; i += 1) {
        const node = slots[i];
        if (node == null) missing.push(i);
        else nodes.push(node);
      }

      if (missing.length > 0) {
        throw new PageFlipError(
          `HTMLFlipBook: ${missing.length} page element(s) never reached the engine ` +
            `(child index ${missing.join(', ')}). A page child must render a host element ` +
            `and forward its ref. Wrap a component child in a <div>, or forward the ref.`,
          'DETACHED_PAGE',
        );
      }

      return nodes;
    }, []);
    /** Page nodes currently loaded into the engine. */
    const loadedNodes = useRef<HTMLElement[] | null>(null);
    /**
     * `pageFlip().destroy()` without unmount is a supported handle path (P3).
     * The engine-effect cleanup never runs, so `engineRef` would keep a dead
     * instance and the next collection pass called `getBlockElement()` —
     * uncaught `DESTROYED` out of a `useEffect`.
     */
    const pageHostRef = useRef<HTMLElement | null>(null);
    const retiredRef = useRef(false);
    const retireIfDestroyed = useCallback((engine: PageFlip): boolean => {
      if (!engine.isDestroyed()) return false;
      retiredRef.current = true;
      loadedNodes.current = null;
      if (engineRef.current === engine) {
        engineRef.current = null;
      }
      const host = pageHostRef.current;
      const active = typeof document === 'undefined' ? null : document.activeElement;
      if (host !== null && active instanceof Node && host.contains(active)) {
        rootRef.current?.focus({ preventScroll: true });
      }
      pageHostRef.current = null;
      setPageHost(null);
      setPageCount(0);
      setEnginePage(0);
      setAnnounced('');
      onPagesChangedHold.current?.({
        page: 0,
        pageCount: 0,
        orientation: 'landscape',
        visiblePages: [],
      });
      return true;
    }, []);
    /**
     * The rendered leaves, STAMPED with the generation whose refs fill
     * `slotsRef`. R-1b.
     *
     * Comparing lengths was not proof of freshness, and the failure was the
     * ordinary case rather than an edge: `childCount.current` is advanced in
     * the children effect of the SAME commit while `pages` still holds the
     * previous list, so whenever the child count is unchanged the two are
     * trivially equal. `children` is a fresh array identity on every parent
     * render, so a turn — which re-renders the parent, and which React 18
     * batches together with the consumer's own `onPageChange` setState —
     * republished an empty slot array and then let the inert effect read it.
     *
     * Measured: a book with `onPageChange` threw on its FIRST turn; the same
     * book without it walked cleanly. Identity of a monotonic stamp is the only
     * thing that actually says "these slots belong to this list".
     */
    const [pages, setPages] = useState<{ gen: number; list: ReactElement[] }>({
      gen: 0,
      list: [],
    });
    const [hydrated, setHydrated] = useState(false);
    /**
     * The engine's `.stf__block`. Pages are portalled into it so React's idea of
     * their parent matches the DOM: the engine used to move them out of the
     * root element, and any later React removal/reorder threw NotFoundError.
     */
    const [pageHost, setPageHost] = useState<HTMLElement | null>(null);
    const [enginePage, setEnginePage] = useState(props.initialPage ?? 0);
    const [pageCount, setPageCount] = useState(0);
    // The live region's text, held separately from `currentPage`/`pageCount` so
    // it can stay empty until a turn actually commits.
    const [announced, setAnnounced] = useState('');
    const didAnnounce = useRef(false);
    /**
     * Landscape shows two leaves, portrait one, and the engine decides which —
     * so both the announcement and the inert set have to follow the engine's
     * orientation rather than a prop. Seeded to the engine's value at load and
     * kept current by `changeOrientation`.
     */
    const [orientation, setOrientation] = useState<PageOrientation>('landscape');

    const currentPage = controlledPage ?? enginePage;
    const hardCovers = props.hardCovers === true;
    // `enginePage`, not `currentPage`: the engine's index is always the FIRST
    // leaf of the spread, while a controlled `page` may name either leaf of it.
    // Memoised so both the live region and the inert effect can depend on it by
    // identity; recomputed on every render it would re-announce constantly.
    // ASK THE ENGINE. This used to call a local `spreadPages()` that
    // reimplemented `createSpread`'s rules — portrait is one leaf, landscape
    // pairs, a cover stands alone — because the collection's spread table was
    // `protected`. `usePageFlip` kept a third copy for `canGoNext`, and it had
    // already drifted: it reported no forward turn on a two-leaf hard-cover
    // book. One owner, one answer.
    //
    // Depends on `pageCount` and `orientation` as well as `enginePage` because
    // those are what change under it; the engine is the source of the value.
    // VALUE-STABLE, not merely memoised (BUG-1). `getVisiblePages()` returns
    // a fresh defensive array on every call (C6), and this memo re-runs on
    // `pages` — which the lazy-window effect itself sets. With `lazyRadius`
    // on, that closed a loop the memo alone cannot break: setPages → new
    // `pages` → new array reference → new `lazyAnchors` → the lazy effect
    // re-runs → setPages → … — heap exhaustion on MOUNT, no flip required.
    // Re-using the previous array whenever the CONTENTS are unchanged makes
    // every downstream dependency see a settled value and the loop terminate,
    // for the whole set, not just the empty-anchors path.
    const visiblePagesRef = useRef<number[]>([]);
    const visiblePages = useMemo(() => {
      const engine = engineRef.current;
      const next = engine && !engine.isDestroyed() ? engine.getVisiblePages() : [];
      const prev = visiblePagesRef.current;
      if (prev.length === next.length && prev.every((leaf, i) => leaf === next[i])) {
        return prev;
      }
      visiblePagesRef.current = next;
      return next;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enginePage, pageCount, orientation, hardCovers, pages]);

    /**
     * R-3. Boundaries are asked of the SPREAD, not the head index.
     *
     * `enginePage` is `spread[0]`, so on the final landscape spread [4, 5] of a
     * six-page book it is 4 — below `pageCount - 1` — and the next control
     * stayed enabled at the end of every landscape book. That is the invariant
     * CLAUDE.md documents ("turns are bounded by spreads, not page indices"),
     * and it bit worst for the browse-mode reader these controls exist for.
     */
    const atStart = pageCount <= 0 || enginePage <= 0;
    const atEnd = pageCount <= 0 || (visiblePages[visiblePages.length - 1] ?? 0) >= pageCount - 1;

    useEffect(() => {
      // Skip the first settled render: announcing the spread the reader has not
      // turned to yet is noise, and it fires for every book on the page.
      if (pageCount <= 0) {
        setAnnounced('');
        return;
      }
      if (!didAnnounce.current) {
        didAnnounce.current = pageCount > 0;
        return;
      }
      setAnnounced(
        liveRegionText(currentPage, pageCount, { pages: visiblePages, orientation, hardCovers }),
      );
    }, [currentPage, pageCount, liveRegionText, visiblePages, orientation, hardCovers]);
    const settings = pickSettings(props);
    const remountKey = remountKeyOf(props);

    /**
     * D15. One failure contract for all four.
     *
     * `flipNext`/`flipPrev` returned `boolean` and never threw, while
     * `turnToPage`/`flipToPage` threw AFTER mount and were silent no-ops
     * BEFORE it — so the same call was an uncaught exception that took down the
     * React tree, or nothing at all, depending on timing the caller cannot see.
     * The repo's own example app used three of the four at once, which is the
     * honest signal that nothing was primary.
     *
     * The ref is the escape hatch; `page` + `onPageChange` is the primary path.
     * A refusal is reported through `onTurnRejected` like every other refusal,
     * so the boolean is a convenience rather than the only channel. The CORE
     * keeps its throw, where a caller can catch it.
     */
    const runHandle = useCallback((page: number, animate: boolean): boolean => {
      const engine = engineRef.current;
      const destroyed = retiredRef.current || engine?.isDestroyed() === true;
      if (!engine || destroyed || engine.getPageCount() <= 0) {
        eventHandlersRef.current.onTurnRejected?.({
          reason: 'notReady',
          direction: null,
          targetPage: page,
          landedOn: null,
          code: destroyed ? 'DESTROYED' : 'NOT_LOADED',
        });
        return false;
      }

      try {
        if (!animate) {
          engine.turnToPage(page);
          return true;
        }

        // The core returns `false` only when a NEWER turn overtook this one.
        // Discarding it made the handle report success for a request the engine
        // had dropped — contradicting `FlipBookHandle.flipToPage`'s own boolean
        // contract, and with no rejection to compensate. The controlled path
        // already handles this; the imperative one did not.
        if (engine.flipToPage(page)) return true;

        eventHandlersRef.current.onTurnRejected?.({
          reason: 'superseded',
          direction: null,
          targetPage: page,
          landedOn: engine.getPageCount() > 0 ? engine.getCurrentPageIndex() : null,
        });
        return false;
      } catch (error: unknown) {
        if (!(error instanceof PageFlipError)) throw error;
        eventHandlersRef.current.onTurnRejected?.({
          // R-4. Both of these are the caller naming a page the book cannot
          // show; neither is a SETUP failure. The mapping was inverted.
          reason:
            error.code === 'INVALID_PAGE' || error.code === 'PAGE_NOT_IN_SPREAD'
              ? 'invalidPage'
              : 'setup',
          direction: null,
          targetPage: page,
          landedOn: engine.getPageCount() > 0 ? engine.getCurrentPageIndex() : null,
          code: error.code,
        });
        return false;
      }
    }, []);

    const runRelative = useCallback((direction: 'next' | 'prev', corner?: FlipCorner): boolean => {
      const engine = engineRef.current;
      // P3. `isDestroyed()` as well as a null ref. A consumer who calls
      // `pageFlip()!.destroy()` WITHOUT unmounting leaves `engineRef` set, and
      // the engine's own `turnRejected` reaches nobody — `destroy()` cleared
      // its listener set. So the handle returned `false` with no callback at
      // all, while the unmount path reported correctly. Same refusal, two
      // contracts, decided by how the engine happened to die.
      if (!engine || engine.isDestroyed() || retiredRef.current) {
        eventHandlersRef.current.onTurnRejected?.({
          reason: 'notReady',
          direction,
          targetPage: null,
          landedOn: null,
          code: retiredRef.current || engine?.isDestroyed() === true ? 'DESTROYED' : 'NOT_LOADED',
        });
        return false;
      }

      return direction === 'next'
        ? engine.flipNext(corner ?? FlipCorner.TOP)
        : engine.flipPrev(corner ?? FlipCorner.TOP);
    }, []);

    const handle: FlipBookHandle = useMemo(
      () => ({
        pageFlip: () => {
          const engine = engineRef.current;
          if (!engine || engine.isDestroyed()) return null;
          return engine;
        },
        // R-5. These reported nothing when the engine was absent, while
        // `runHandle` reported `notReady` — two of the four methods refusing
        // silently, which is the contradiction D15 exists to remove. The engine
        // emits `turnRejected` itself when it IS present, so this only covers
        // the before-mount / after-unmount window it cannot see.
        flipNext: (corner?: FlipCorner) => runRelative('next', corner),
        flipPrev: (corner?: FlipCorner) => runRelative('prev', corner),
        turnToPage: (page: number) => runHandle(page, false),
        flipToPage: (page: number) => runHandle(page, true),
        cancelTurn: () => {
          const engine = engineRef.current;
          if (!engine || engine.isDestroyed() || retiredRef.current) return false;
          return engine.cancelTurn();
        },
        destroy: () => {
          const engine = engineRef.current;
          if (!engine || engine.isDestroyed() || retiredRef.current) return;
          engine.destroy();
          retireIfDestroyed(engine);
        },
      }),
      [runHandle, runRelative, retireIfDestroyed],
    );

    useImperativeHandle(ref, () => handle, [handle]);

    // MEMOISED. This feeds an effect dependency array, and a fresh array
    // literal every render re-runs that effect, which re-renders — an infinite
    // loop that shows up as a heap exhaustion, not as a failing assertion.
    const lazyAnchors = useMemo(
      () => (lazyRadius !== undefined ? visiblePages : EMPTY_ANCHORS),
      [lazyRadius, visiblePages],
    );

    useEffect(() => {
      // D1. INDEX-KEYED SLOTS, not append order.
      //
      // `collect` was a bare push, so a child whose ref never fired simply did
      // not appear — and `cloneElement(el, { ref })` never fires for a
      // component that does not forward its ref. With SOME such children the
      // node list is shorter than the page list, `updateFromHtml` succeeds, and
      // every index this binding computes — `inert`, the live region,
      // `visiblePages` — is against a different list than the engine's. Pages
      // silently mis-inert and the announcement silently lies.
      //
      // The rule needed three examples and a README section to explain and
      // produced no runtime signal, which is what makes it an API defect rather
      // than a docs gap. A null slot after commit is now PROOF that a specific
      // child could not be reffed, so it throws and names the index.
      //
      // Order comes from the index, so the append-order reset dance and its
      // documented "bail out BEFORE clearing" hazard are gone, and StrictMode's
      // double-invoke is idempotent — slot `i` is simply written twice.
      const slots: Array<HTMLElement | null> = [];
      const collect = (index: number) => (el: HTMLElement | null) => {
        slots[index] = el;
      };
      const next = wrapChildren(children, lazyAnchors, lazyRadius, collect);

      // P2. NO WARNING HERE any more.
      //
      // This used to warn for any child whose `type` was not a string — which
      // fires for a `forwardRef` component that forwards its ref CORRECTLY, i.e.
      // exactly the pattern the docs recommend. A false positive on the
      // documented happy path teaches consumers to ignore our warnings.
      //
      // Whether a child reached the engine is answerable precisely, one commit
      // later, by whether its slot is still null — and `readNodes()` already
      // throws `DETACHED_PAGE` naming the index when it is. That is the signal;
      // this heuristic was a worse version of it fired earlier.
      const gen = (slotGeneration.current += 1);
      slotsRef.current = slots;
      childCount.current = next.length;
      setPages({ gen, list: next });
    }, [children, lazyAnchors, lazyRadius]);

    // Handlers are dispatched through a ref so `bindHandlers` is stable. With
    // the props in the dependency list, an inline `onFlip={(e) => …}` gave the
    // load effect a new identity on every render — and a flip always causes a
    // render — so the whole PageCollection was torn down and rebuilt on each
    // turn, mid-animation.
    const eventHandlersRef = useRef({
      onPageChange,
      onChangeOrientation,
      onChangeState,
      onReady,
      onLoaded,
      onPagesChanged,
      onTurnRejected,
      onTurnProgress,
    });

    useEffect(() => {
      eventHandlersRef.current = {
        onPageChange,
        onChangeOrientation,
        onChangeState,
        onReady,
        onLoaded,
        onPagesChanged,
        onTurnRejected,
        onTurnProgress,
      };
    });

    const handlersBoundRef = useRef(false);
    /**
     * The FIRST controlled application is instant regardless of
     * `pageTransition`: a book mounting at `page={7}` should open there, not
     * animate through to it from page 0.
     */
    const firstControlledApply = useRef(true);
    /**
     * When the last real page turn happened, and how many engines this
     * component has built — together they detect the URL-sync footgun: a
     * consumer feeding `searchParams` into `initialPage` remounts the engine
     * on every turn (the turn writes the URL, the URL changes `initialPage`,
     * `initialPage` is remount-keyed). It looks like "the book flickers at
     * turn end" and cost the first integration a day (Puddlebend Issue 2).
     */
    const lastFlipAt = useRef(0);
    const engineBuilds = useRef(0);
    const lastInitialPage = useRef<number | undefined>(undefined);
    const bindHandlers = useCallback((flip: PageFlip) => {
      if (handlersBoundRef.current) return;
      handlersBoundRef.current = true;

      // D18. Every handler receives the PAYLOAD. The engine's `on()` keeps its
      // `WidgetEvent` wrapper; the binding unwraps uniformly rather than for
      // one prop, which is the asymmetry ADR 0003 blamed for consumers binding
      // the wrong event.
      flip.on('flip', (e: WidgetEvent<FlipbookEventMap['flip']>) => {
        lastFlipAt.current = Date.now();
        setEnginePage(e.data.page);
        setPageCount(e.data.pageCount);
        eventHandlersRef.current.onPageChange?.(e.data);
      });
      flip.on('changeOrientation', (e: WidgetEvent<FlipbookEventMap['changeOrientation']>) => {
        // Drives how many leaves count as "on screen".
        setOrientation(e.data.orientation === 'portrait' ? 'portrait' : 'landscape');
        eventHandlersRef.current.onChangeOrientation?.(e.data);
      });
      flip.on('changeState', (e: WidgetEvent<FlipbookEventMap['changeState']>) => {
        eventHandlersRef.current.onChangeState?.(e.data);
      });
      flip.on('ready', (e: WidgetEvent<FlipbookEventMap['ready']>) => {
        eventHandlersRef.current.onReady?.(e.data);
      });
      flip.on('loaded', (e: WidgetEvent<FlipbookEventMap['loaded']>) => {
        eventHandlersRef.current.onLoaded?.(e.data);
      });
      flip.on('pagesChanged', (e: WidgetEvent<FlipbookEventMap['pagesChanged']>) => {
        setPageCount(e.data.pageCount);
        // Re-derive the index too. A rebuild that shrinks the book below the
        // current index leaves the engine on a different leaf, and a
        // `pageCount` refreshed without it announced "Page 5 of 3" and inerted
        // the leaf the reader is actually looking at.
        //
        // The ENGINE is asked, not `e.data.page`: `replacePages` reports a
        // clamped, resolved index, but `updateFromHtml` — the path this
        // binding uses — reports the index it carried IN, before the new
        // collection refused it. `getCurrentPageIndex()` is the one value that
        // is true on both paths.
        setEnginePage(flip.getCurrentPageIndex());
        eventHandlersRef.current.onPagesChanged?.(e.data);
      });
      flip.on('turnRejected', (e: WidgetEvent<FlipbookEventMap['turnRejected']>) => {
        eventHandlersRef.current.onTurnRejected?.(e.data);
      });
      flip.on('turnProgress', (e: WidgetEvent<FlipbookEventMap['turnProgress']>) => {
        eventHandlersRef.current.onTurnProgress?.(e.data);
      });
    }, []);

    useEffect(() => {
      const root = rootRef.current;
      if (!root) return;

      // Dev-only, and only for an `initialPage` change — a `hardCovers` or
      // `injectStyles` remount near a turn is a legitimate layout change, not
      // the footgun. OPT-IN dev detection: `process` is absent in an
      // unbundled browser, so the gate requires an EXPLICIT dev/test
      // NODE_ENV rather than "not production" — a plain-ESM production page
      // must never see this. (Typed globalThis access keeps the package free
      // of @types/node; bundlers substitute the literal.)
      const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
        ?.NODE_ENV;
      const initialPageChanged =
        engineBuilds.current > 0 && lastInitialPage.current !== props.initialPage;
      if (
        initialPageChanged &&
        Date.now() - lastFlipAt.current < 1000 &&
        (nodeEnv === 'development' || nodeEnv === 'test')
      ) {
        console.warn(
          '[flipbook] `initialPage` changed within 1s of a page turn, remounting the ' +
            'engine mid-read. This usually means initialPage is fed from the URL while ' +
            'onPageChange writes the URL — every turn then rebuilds the book (a flicker ' +
            'at animation end). Freeze the deep link at mount, or drive position with ' +
            'the controlled `page` prop instead.',
        );
      }
      engineBuilds.current += 1;
      lastInitialPage.current = props.initialPage;

      const engine = new PageFlip(root, settings);
      retiredRef.current = false;
      engineRef.current = engine;
      handlersBoundRef.current = false;
      firstControlledApply.current = true;
      bindHandlers(engine);

      // Build the DOM shell with no leaves, so there is a portal target before
      // any page exists. Pages are handed to the engine by the effect below.
      engine.loadFromHTML([]);
      loadedNodes.current = [];

      const block = engine.getBlockElement();
      pageHostRef.current = block;
      setPageHost(block);
      setHydrated(true);

      return () => {
        handlersBoundRef.current = false;
        firstControlledApply.current = true;
        retiredRef.current = false;
        const leaves = loadedNodes.current ?? [];
        engine.destroy();

        // Put the leaves back under the block React still records as their
        // parent. `destroy()` "restores" adopted leaves to where they were
        // adopted from — and the pages effect hands them to the engine before
        // the portal's first commit, so the engine adopted them DETACHED and
        // the restore parks them on the host. React's next commit (a
        // remount-key change re-targeting the portals, or unmount removing
        // them) then calls `oldBlock.removeChild(leaf)` on a leaf that is no
        // longer there: NotFoundError, measured on any runtime `hardCovers`
        // change. The block is already out of the document; this only makes
        // React's recorded parent true again so IT can move the leaves.
        for (const leaf of leaves) {
          if (leaf.parentElement !== block) block.appendChild(leaf);
        }

        pageHostRef.current = null;
        setPageHost(null);
        loadedNodes.current = null;
        if (engineRef.current === engine) {
          engineRef.current = null;
        }
      };
      // Recreate only when constructor-level layout identity changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remountKey, bindHandlers]);

    useEffect(() => {
      const engine = engineRef.current;
      if (!engine || retireIfDestroyed(engine)) return;
      // MIN-6. Typed `LiveSetting` at the call site, so D19's compile-time
      // fence applies to the binding too. Passing the `FlipOptions` variable
      // skipped excess-property checking, which meant the one call site that
      // matters most got no protection from the type that exists for it.
      const {
        hardCovers: _hardCovers,
        initialPage: _initialPage,
        // C5: construction-time like its two siblings. `pickSettings(_, true)`
        // sends absent keys as EXPLICIT undefined ("back to the default"),
        // which for a construction-time key silently rewrites the authored
        // value the engine was built with — measured: `injectStyles={false}`
        // flipped back to the default true here, and the first-content
        // re-attach then built a UI that injected the stylesheet the mount
        // had correctly withheld.
        injectStyles: _injectStyles,
        ...live
      } = pickSettings(props, true);
      const liveSettings: Partial<LiveSetting> = live;

      engine.updateSettings(liveSettings);
      // settings object is rebuilt each render; identity is not load-bearing.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      props.width,
      props.height,
      // B1, and a regression I introduced: `sizing` was dropped from
      // `remountKeyOf` last round because it IS live and updateSettings
      // handles it — but it was never added here, so it became a prop that
      // does nothing at all. Worse than the remount it replaced, and silent:
      // a consumer toggling fixed <-> responsive at a breakpoint sees width
      // and height update (those ARE in this list) while the mode does not,
      // so the book gets a new pixel size in the wrong mode and it reads as a
      // bug in their own CSS.
      props.sizing,
      props.usePortrait,
      props.pointerInput,
      props.flippingTime,
      props.respectReducedMotion,
      props.readingDirection,
      props.pageBackground,
      props.drawShadow,
      props.foldCornerOnHover,
      props.flipOnClick,
      props.swipeDistance,
      props.respectInteractiveContent,
      props.allowTouchScroll,
      props.maxShadowOpacity,
      props.startZIndex,
      props.autoSize,
      props.minWidth,
      props.maxWidth,
      props.minHeight,
      props.maxHeight,
    ]);

    useEffect(() => {
      const engine = engineRef.current;
      if (!engine || retireIfDestroyed(engine)) return;

      // R-1. GUARD BEFORE READING.
      //
      // The children effect publishes a FRESH, empty slot array and then calls
      // `setPages`; the refs that fill it belong to elements that render in the
      // NEXT commit. This effect runs in the same passive-effect flush as that
      // publish, so calling `readNodes()` at the top saw every slot null and
      // threw `DETACHED_PAGE` on the first mount of every book — the throw is
      // the right contract, consulted at the wrong moment.
      //
      // `pages.length === childCount.current` is the proof that the commit
      // which fills the slots has happened: `pages` is state, so it only holds
      // the new list after that commit, and the refs fire during it. Softening
      // the throw instead would have thrown away the whole point of D1.
      if (!pageHost || pages.list.length === 0) return;
      // R-1b. Identity of the stamp, not equality of lengths. `pages` is state,
      // so it only carries this generation after the commit that fired the refs
      // filling `slotsRef` for it.
      if (pages.gen !== slotGeneration.current) return;

      // A REMOUNT runs this effect once with the OLD `pageHost` closure and
      // the NEW engine (the ref is live, the state is not): handing the nodes
      // over here adopts them into the new block while React still records
      // the old one as their parent, and React's portal re-target then throws
      // NotFoundError removing them — measured on any runtime remount-key
      // change (`hardCovers`, `injectStyles`). The engine may only adopt once
      // the portal has committed into ITS block; until `pageHost` catches up,
      // this pass is not ours.
      if (engine.getBlockElement() !== pageHost) return;

      const nodes = readNodes();
      if (nodes.length === 0) return;

      // Handlers MUST be attached before updateFromHtml so `onUpdate` fires
      // (upstream removed listeners, emitted `update`, then re-attached).
      bindHandlers(engine);

      // Rebuild only when the page nodes themselves changed. A parent re-render
      // (every flip causes one) hands us new React elements but the SAME DOM
      // nodes; rebuilding there tore down the PageCollection on every turn,
      // mid-animation, and emitted a spurious `collectionRebuild`.
      if (sameNodes(loadedNodes.current, nodes)) {
        return;
      }

      engine.updateFromHtml(nodes);
      loadedNodes.current = nodes.slice();
      setPageCount(engine.getPageCount());
      // Seed from the engine: `changeOrientation` only fires on a CHANGE, so a
      // book that is landscape from the first layout never emits one.
      setOrientation(engine.getOrientation() === 'portrait' ? 'portrait' : 'landscape');

      // C7 / D17. `initialPage` is honoured by the ENGINE now, not compensated
      // for here.
      //
      // This used to call `engine.turnToPage(start)` after the first real
      // collection, because `initialPage` is read only by `attachMode` and this
      // binding mounts with `loadFromHTML([])`. A turn ANNOUNCES, so an
      // uncontrolled `<HTMLFlipBook initialPage={1}>` fired `onPageChange` on
      // mount for a page nobody had turned to — the same defect ADR 0003 fixed
      // in the core, re-created one layer up.
      //
      // `updateFromHtml` now carries the opening index, so opening at a page is
      // not a turn on either side of the boundary. `initialPage` is part of the
      // remount key, so changing it rebuilds rather than being ignored (D6).
      setEnginePage(engine.getCurrentPageIndex());
    }, [pages, pageHost, bindHandlers, remountKey, readNodes, retireIfDestroyed]);

    /*
     * Every leaf is in the DOM at all times, stacked, so a link or button on a
     * page behind the current spread must not be in the tab order: a keyboard
     * user would tab off the book onto a control they cannot see, on a page
     * they are not reading — WCAG 2.4.3 (Focus Order).
     *
     * Be honest about what this buys: `HTMLRender.clear()` already stamps
     * `display:none` onto every off-spread leaf on each frame, and a
     * `display:none` subtree is untabbable, so a settled book was already safe.
     * `inert` covers what that does not: the mid-flip window, where the
     * outgoing leaf, the fold and the bottom page are all `display:block` at
     * once, and any consumer stylesheet that forces its own display onto
     * `.stf__item`. It is also declarative rather than a side effect of the
     * render loop, so it holds whenever the loop is stopped.
     *
     * `inert` is set on the DOM node rather than rendered as a JSX prop
     * deliberately: React only started passing a boolean `inert` through to the
     * DOM in 19, and `react` here is a peer dependency of `>=18`. On React 18 a
     * boolean `inert` prop is dropped with a warning, so the fix would silently
     * not apply for a large share of consumers. The attribute is the same thing
     * the browser reads, and React never manages it here.
     *
     * Accepted cost: `inert` also removes those pages from find-in-page. A
     * focus-order failure outranks a search convenience — and the pages are
     * visually hidden anyway, so finding text on them was already misleading.
     */
    useEffect(() => {
      // Before the collection loads there is no spread yet, and inerting every
      // leaf for that one commit would blank the tab order of a mounting book.
      // Same commit-ordering guard as the load effect — see R-1 there.
      // Destroy-without-unmount drops the portal; slots go null and a later
      // children pass must not call readNodes() (DETACHED_PAGE).
      if (!pageHost || pageCount <= 0 || pages.list.length === 0) return;
      if (pages.gen !== slotGeneration.current) return;

      const nodes = readNodes();
      if (nodes.length === 0) return;

      const visible = new Set(visiblePages);

      /*
       * Rescue focus BEFORE inerting, not after.
       *
       * A turn can happen while focus sits on a control inside the leaf that is
       * turning away — a click on the consumer's "next" button, a programmatic
       * `turnToPage`, an autoplay, or the reader's own Arrow key after tabbing
       * back out. The moment `inert` lands on an ancestor of
       * `document.activeElement` the browser blurs it and focus resets to
       * `<body>`: the keyboard user is silently teleported to the top of the
       * document and the next Tab restarts from there (WCAG 2.4.3 Focus Order,
       * and 3.2.x — a context change nobody asked for).
       *
       * Moving focus to the book root keeps it where the reader is, keeps the
       * root's own Arrow/Home/End handler live, and — because the root is
       * `role="group"` with `aria-roledescription` and a name — gives AT
       * something meaningful to announce instead of "HTML content".
       *
       * The root therefore carries `tabIndex={-1}` even when `useKeyboard` is
       * off: without it `focus()` on a plain <div> is a no-op and focus would
       * still land on <body>.
       */
      const active = typeof document === 'undefined' ? null : document.activeElement;
      const losesFocus =
        active !== null &&
        nodes.some((node, index) => !visible.has(index) && node.contains(active));

      if (losesFocus) rootRef.current?.focus({ preventScroll: true });

      nodes.forEach((node, index) => {
        if (visible.has(index)) node.removeAttribute('inert');
        else node.setAttribute('inert', '');
      });

      return () => {
        // The nodes belong to the consumer; leave none of ours behind.
        for (const node of nodes) node.removeAttribute('inert');
      };
    }, [pages, visiblePages, pageCount, readNodes, pageHost]);

    useEffect(() => {
      const engine = engineRef.current;
      if (!engine || controlledPage === undefined) return;
      if (!engine.isReady()) return;
      // Empty portal shell has no leaves yet — don't treat start page as OOB.
      if (engine.getPageCount() <= 0) return;

      // A controlled page is satisfied when it is ON SCREEN, not when it
      // equals the engine's index: that index is the spread HEAD, so in
      // landscape the spread [0, 1] reports 0 and `page={1}` never matched.
      // The effect re-issued `turnToPage(1)`, the engine showed the same
      // spread and emitted `flip` with 0, and `onPageChange(0)` rewrote the
      // consumer's own value — the component and the engine then disagreed
      // about a book that was already showing the requested leaf.
      //
      // Membership is asked of the ENGINE, not derived here: the cover is a
      // spread of one, so "pair the leaves two at a time" is wrong exactly when
      // `hardCovers` is set.
      if (engine.getVisiblePages().includes(controlledPage)) {
        // CLEAR THE FLAG ON THE EARLY RETURN TOO.
        //
        // In the ordinary `page={0}` case the first run finds page 0 already
        // visible and returned here without clearing it — so the next change,
        // a real user-driven navigation, still read as "initial" and used the
        // instant path. A controlled book's first declarative turn was a silent
        // page swap despite `pageTransition` defaulting to 'animate'.
        firstControlledApply.current = false;
        return;
      }

      // D14. ANIMATE by default.
      //
      // The controlled path called `turnToPage` (instant) while the ref's
      // `flipToPage` called `engine.flip` (animated) — so in a page-FLIP
      // library the declarative path silently opted out of the entire point,
      // undiscoverably. The engine's own comments describe the better design:
      // `Flip.flipToPage` reasons explicitly about being "driven straight from
      // the React binding's controlled `page` prop", which is not what the
      // binding did. `pageTransition: 'instant'` is there for deep links.
      const animate = pageTransition === 'animate' && !firstControlledApply.current;
      firstControlledApply.current = false;

      try {
        if (animate) {
          // MIN-10. A superseded turn used to vanish: `flip` returned void, so
          // the effect saw no change, did not re-run, and the book rested
          // somewhere the prop had not asked for with nothing reported.
          if (!engine.flipToPage(controlledPage)) {
            eventHandlersRef.current.onTurnRejected?.({
              reason: 'superseded',
              direction: null,
              targetPage: controlledPage,
              landedOn: engine.getPageCount() > 0 ? engine.getCurrentPageIndex() : null,
            });
          }
        } else {
          engine.turnToPage(controlledPage);
        }
      } catch (error: unknown) {
        // Only the engine refusing the page is a navigation error. A consumer
        // handler that throws, or a broken renderer, must not be relabelled as
        // "invalid page" and hidden.
        if (!(error instanceof PageFlipError)) throw error;

        const count = engine.getPageCount();
        const actual = count <= 0 ? 0 : Math.min(Math.max(0, controlledPage), count - 1);
        try {
          if (count > 0 && actual !== engine.getCurrentPageIndex()) engine.turnToPage(actual);
        } catch (clampError: unknown) {
          // The clamp is a best effort; if even that page is refused we still
          // report below. A non-engine failure is still a defect.
          if (!(clampError instanceof PageFlipError)) throw clampError;
        }
        setEnginePage(engine.getCurrentPageIndex());

        // D16/D18. Reported through `turnRejected` like every other refusal.
        // `onNavigationError` was a React-only fourth channel for a condition
        // the engine already reports, and it hardcoded `INVALID_PAGE`,
        // discarding the `PAGE_NOT_IN_SPREAD` distinction the core paid for.
        eventHandlersRef.current.onTurnRejected?.({
          // R-4. Both of these are the caller naming a page the book cannot
          // show; neither is a SETUP failure. The mapping was inverted.
          reason:
            error.code === 'INVALID_PAGE' || error.code === 'PAGE_NOT_IN_SPREAD'
              ? 'invalidPage'
              : 'setup',
          direction: null,
          targetPage: controlledPage,
          // The clamp above already ran, so this is where the reader ACTUALLY
          // is — the field `onNavigationError` called `actual`.
          landedOn: engine.getPageCount() > 0 ? engine.getCurrentPageIndex() : null,
          code: error.code,
        });
      }
      // D13. `enginePage` IS a dependency, and that is what makes `page`
      // controlled.
      //
      // The effect used to depend on `[controlledPage, pages]` only, so nothing
      // re-asserted when the ENGINE moved: a swipe turned the book, the prop
      // was unchanged, the effect never re-ran, and the book stayed where the
      // user put it while the component knew it disagreed and said nothing.
      // `<input value="a">` does not become `"b"`.
      //
      // With this, `page` without `onPageChange` is a genuinely locked book and
      // `page` + `onPageChange` round-trips.
    }, [controlledPage, pages, enginePage, pageTransition]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (!useKeyboard) return;
      const engine = engineRef.current;
      if (!engine || engine.isDestroyed()) return;

      // A MODIFIED arrow is somebody else's shortcut, and swallowing it (with
      // `preventDefault`, no less) takes a documented browser behaviour away
      // from the keyboard user who needs it most: Alt+ArrowLeft / Alt+ArrowRight
      // are Back and Forward on Windows and Linux, Cmd+ArrowLeft is Back on
      // macOS, and Ctrl+Home / Ctrl+End jump to the top and bottom of the
      // document — the two keys a screen-reader user presses to get out of a
      // widget. Ours are the UNMODIFIED keys only, which is also what
      // `aria-keyshortcuts="ArrowLeft ArrowRight Home End"` promises.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      // A keydown only reaches this handler by bubbling up from
      // `document.activeElement`. If that is not the root itself, focus is on
      // some focusable thing INSIDE a page, and arrow keys belong to it.
      //
      // This used to ask `FLIPBOOK_INTERACTIVE_SELECTOR` instead — a list built
      // for POINTER targets (what should not start a fold). As a keyboard rule
      // it under-matches badly: a `tabindex="0"` scroll region, `<video
      // controls>`, `<audio>`, an `<iframe>`, a `<details>` body, or any custom
      // widget that is focusable without one of those roles is not on it, so
      // the book stole its arrow keys and called `preventDefault`. Focus is the
      // authority on who owns a key press; a selector is not.
      if (event.target !== event.currentTarget) return;

      const rtl = props.readingDirection === 'rtl';
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (rtl) runRelative('prev');
        else runRelative('next');
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (rtl) runRelative('next');
        else runRelative('prev');
      } else if (event.key === 'Home') {
        event.preventDefault();
        // D7. `runHandle` REPORTS the refusal. These two used to swallow it
        // silently while `ArrowLeft`/`ArrowRight` reported theirs through
        // `turnRejected` — the same gesture, two different contracts, decided
        // by which key was pressed.
        runHandle(0, false);
      } else if (event.key === 'End') {
        event.preventDefault();
        runHandle(Math.max(0, engine.getPageCount() - 1), false);
      }
    };

    /*
     * Composite widget: keyboard turns when focused (Arrow/Home/End).
     *
     * jsx-a11y objects to a tabIndex and a keydown handler on a `group`. Its
     * model is "make the role interactive" — and the only role that would
     * satisfy it here is `application`, which is precisely what must not be
     * used: it strips the virtual cursor from NVDA and JAWS for the whole
     * subtree, and linear reading is the entire value of a book to a
     * screen-reader user. A single-tab-stop composite with a `group` role is
     * the APG carousel shape; the rule simply does not model composites.
     * Browse-mode users turn pages with the controls, not the arrows.
     */
    return (
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
      <div
        ref={rootRef}
        // MIN-8. `stf__parent` is declared HERE, not left to the engine alone.
        // `UI` adds it to this same element, and React replaces the whole
        // `class` attribute on a runtime `className` change — taking
        // `position:relative; display:block; touch-action` with it and breaking
        // the positioning context mid-session. The engine's add stays (it is
        // idempotent, and the engine must work without React); this makes React
        // aware of a class it was silently clobbering.
        className={[
          className === undefined || className === '' ? undefined : className,
          'stf__parent',
          props.allowTouchScroll === false ? '--lock-touch-scroll' : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join(' ')}
        style={style}
        data-flipbook-placeholder={hydrated ? undefined : ''}
        aria-label={ariaLabel}
        // NEVER `application`. It forces NVDA and JAWS out of browse mode for
        // the whole subtree, which removes the virtual cursor: no
        // element-by-element reading, no heading/graphic quick-nav, no "say
        // all", no find-in-page. For a BOOK, linear reading is the entire value
        // to a screen-reader user, so buying arrow keys with it is the worst
        // trade available. Browse-mode users turn pages with real controls.
        role="group"
        aria-roledescription={roleDescription}
        // `-1` rather than absent when keyboard turning is off: the root is the
        // focus target the inert effect falls back to when a turn takes the
        // leaf holding focus away, and `focus()` on a div with no tabindex is a
        // no-op. `-1` keeps it out of the tab order, so nothing else changes.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- see above
        tabIndex={useKeyboard ? 0 : -1}
        aria-keyshortcuts={useKeyboard ? 'ArrowLeft ArrowRight Home End' : undefined}
        data-flipbook-kb={useKeyboard ? '' : undefined}
        onKeyDown={useKeyboard ? onKeyDown : undefined}
      >
        {/*
          The focus ring and the controls' reveal live in `FLIPBOOK_CSS`, not
          here. An inline <style> is blocked by a strict CSP without
          'unsafe-inline' — which took the reveal with it and left a sighted
          keyboard user focusing a control they could not see — and emitting it
          per component duplicates the rules once per book on the page.
        */}
        {pageHost ? createPortal(pages.list, pageHost) : null}
        {/*
          H4. REAL BUTTONS, and this is a defect fix rather than a convenience.

          A screen-reader user in BROWSE mode — the default for NVDA and JAWS,
          and VoiceOver's equivalent — never receives our Arrow keys: the
          virtual cursor consumes them for element-by-element reading. The one
          role that would deliver them is `application`, which is precisely what
          this component must not use, because it takes the virtual cursor away
          for the whole subtree and linear reading is the entire value of a book
          to that reader.

          The comment on the root has said "browse-mode users turn pages with
          the controls" since the keyboard work landed. There were no controls.
          Until now that reader could not turn a page at all, by any means.

          Rendered OUTSIDE the portal so they are not adopted, styled or
          positioned by the engine, and placed after the pages so the reading
          order is content-then-controls.
        */}
        {controls !== 'none' ? (
          <div
            data-flipbook-controls={controls === 'visible' ? 'visible' : ''}
            style={controls === 'visible' ? undefined : VISUALLY_HIDDEN_UNTIL_FOCUS}
          >
            {/*
              R-6. `aria-disabled`, NOT `disabled`, and this is the whole reason
              the APG recommends it for controls in a composite.

              The disabled state is derived from the current page, so reaching a
              boundary BY CLICKING the control disables the element that has
              focus. Browsers blur a disabled element and focus resets to
              `<body>` — so the keyboard or AT user who clicks "Previous page"
              until they reach the cover is silently teleported to the top of
              the document. That is exactly the WCAG 2.4.3 failure the
              focus-rescue effect exists to prevent, arriving through the
              control H4 added for that same user.

              `aria-disabled` announces the state, keeps the element focusable,
              and leaves focus where the reader put it. The handler no-ops.
            */}
            <button
              type="button"
              data-flipbook-control="prev"
              aria-disabled={atStart || undefined}
              onClick={() => {
                if (atStart) return;
                runRelative('prev');
              }}
            >
              {controlLabels.previous}
            </button>
            <button
              type="button"
              data-flipbook-control="next"
              aria-disabled={atEnd || undefined}
              onClick={() => {
                if (atEnd) return;
                runRelative('next');
              }}
            >
              {controlLabels.next}
            </button>
          </div>
        ) : null}
        {liveRegion ? (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-flipbook-live=""
            style={VISUALLY_HIDDEN}
          >
            {/*
              Mounts EMPTY. `pageCount` starts at 0, so rendering the text
              immediately produced "Book", then a mutation to "Page 1 of 32"
              once the collection loaded — a real live-region change, which AT
              announces. Every book on the page introduced itself during load.
            */}
            {announced}
          </div>
        ) : null}
      </div>
    );
  },
);
