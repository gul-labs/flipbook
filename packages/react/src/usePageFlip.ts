'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlipCorner } from '@gullabs/flipbook-core';
import type {
  BookSnapshot,
  FlipBookHandle,
  IEventProps,
  PageOrientation,
  TurnRejected,
} from './types';

/**
 * State + actions for a flipbook. Pass `ref` to `<HTMLFlipBook ref={ref} />`
 * and spread `bookProps`.
 *
 * COMPLETED rather than deleted (Codex design signoff). After D13–D15 a
 * consumer's own `useState` plus `page`/`onPageChange` is most of this hook —
 * but `orientation` alone justifies it: a consumer cannot render correct
 * controls without knowing whether one leaf or two are on screen, and there is
 * no other way to learn that without binding an event by hand.
 *
 * ONE readonly snapshot, updated atomically. The previous shape exposed `page`,
 * `pageCount`, `setPage` and `setPageCount` as four independent pieces, so a
 * caller could set a page the count did not admit, and `setPageCount` wrote to
 * state that is DERIVED from the engine — a value the next event overwrote.
 *
 * `setPage` is replaced by {@link goToPage}, which actually turns the book.
 * Restoring a saved reading position is a real use case and deleting the
 * setter outright would have stranded it; a setter that moved nothing while
 * desyncing the state from the engine was the wrong shape for it.
 *
 * This hook is UNCONTROLLED plus imperative actions: `bookProps` carries event
 * handlers and `initialPage`, never a `page`. An earlier version of these docs
 * reasoned about feeding a controlled `page`, which the shape does not do.
 *
 * Before mount (and after unmount) there is no engine behind `ref`, so the
 * actions are no-ops returning `false`. That is the contract, not an oversight:
 * these get called from effects and handlers that can legitimately run early,
 * and throwing there would punish correct code.
 */
export interface FlipbookState {
  /** The spread HEAD — the first leaf on screen. */
  page: number;
  pageCount: number;
  orientation: PageOrientation;
  /** Whether a forward turn is possible from here. */
  canGoNext: boolean;
  canGoPrev: boolean;
  /** Leaf indices on screen, in reading order. One in portrait, two in landscape. */
  visiblePages: number[];
  /**
   * The most recent refusal, or `null`.
   *
   * Cleared by the next successful TURN. Deliberately not cleared by a load or
   * by the engine sync below — a refusal a consumer is about to render should
   * survive an unrelated reflow.
   */
  lastRejection: TurnRejected | null;
}

const INITIAL: FlipbookState = {
  page: 0,
  pageCount: 0,
  orientation: 'landscape',
  canGoNext: false,
  canGoPrev: false,
  visiblePages: [],
  lastRejection: null,
};

/**
 * Bounds come from the ENGINE now — `canTurn` is spread-bounded and the engine
 * owns that rule. This used to pair from the head locally and had already
 * drifted: it reported no forward turn on a two-leaf hard-cover book, because
 * its copy did not know a cover is a spread of one.
 */
function withBounds(state: FlipbookState, handle: FlipBookHandle | null): FlipbookState {
  const engine = handle?.pageFlip() ?? null;
  const live = engine !== null && !engine.isDestroyed();

  return {
    ...state,
    canGoPrev: live ? engine.canTurn('prev') : false,
    canGoNext: live ? engine.canTurn('next') : false,
    visiblePages: live ? engine.getVisiblePages() : [],
  };
}

export function usePageFlip(initialPage = 0, options: { hardCovers?: boolean } = {}) {
  const hardCovers = options.hardCovers === true;
  const ref = useRef<FlipBookHandle | null>(null);
  const [state, setState] = useState<FlipbookState>(() =>
    withBounds({ ...INITIAL, page: initialPage }, null),
  );

  /**
   * `clearRejection` is false for load events. A rejection is cleared by a
   * successful TURN, which is what the field documents; clearing it on every
   * `loaded` swallowed the refusal a consumer was about to render.
   */
  const apply = useCallback((snapshot: BookSnapshot, clearRejection = true) => {
    setState((previous) =>
      withBounds(
        {
          ...previous,
          page: snapshot.page,
          pageCount: snapshot.pageCount,
          orientation: snapshot.orientation === 'portrait' ? 'portrait' : 'landscape',
          lastRejection: clearRejection ? null : previous.lastRejection,
        },
        ref.current,
      ),
    );
  }, []);

  const flipNext = useCallback((corner?: FlipCorner) => ref.current?.flipNext(corner) ?? false, []);
  const flipPrev = useCallback((corner?: FlipCorner) => ref.current?.flipPrev(corner) ?? false, []);
  const turnToPage = useCallback((next: number) => ref.current?.turnToPage(next) ?? false, []);
  const flipToPage = useCallback((next: number) => ref.current?.flipToPage(next) ?? false, []);

  /**
   * Move the book to a page. The replacement for the removed `setPage`.
   *
   * An ACTION rather than a setter: `setPage` wrote hook state the engine did
   * not know about, so the two disagreed until the next event overwrote it.
   * This turns the book and lets the resulting event update the state, which is
   * the only version that cannot desync.
   */
  const goToPage = useCallback(
    (next: number, transition: 'animate' | 'instant' = 'animate') =>
      transition === 'animate'
        ? (ref.current?.flipToPage(next) ?? false)
        : (ref.current?.turnToPage(next) ?? false),
    [],
  );

  /**
   * Ask the ENGINE where the book landed; fall back to the payload only when
   * there is no engine to ask (no `ref` spread onto the component, or the event
   * replayed after unmount).
   *
   * `snapshot.page` is a *report* of the engine's index, derived one layer up;
   * `getCurrentPageIndex()` is the index itself. Both are correct today, but
   * this hook can feed a CONTROLLED `page`, so a wrong value here is not a
   * stale label — it re-issues a turn on a leaf that may not exist. Deriving
   * stays right if the emitting layer regresses (which it had:
   * `updateFromHtml` reported the pre-rebuild index), while trusting the
   * payload is right only for as long as every emitter is.
   */
  const onPagesChanged = useCallback(
    (snapshot: BookSnapshot) => {
      const engine = ref.current?.pageFlip() ?? null;
      // A destroyed engine has released its collection, and
      // `getCurrentPageIndex()` would throw `NOT_LOADED` rather than answer.
      const live =
        engine !== null && !engine.isDestroyed() ? engine.getCurrentPageIndex() : snapshot.page;

      apply({ ...snapshot, page: live });
    },
    [apply],
  );

  const onTurnRejected = useCallback((info: TurnRejected) => {
    setState((previous) => ({ ...previous, lastRejection: info }));
  }, []);

  /**
   * Spread onto `<HTMLFlipBook {...bookProps} />`.
   *
   * ORDER MATTERS, and it used to matter silently. Spreading these FIRST and
   * then passing your own `onPageChange` overwrites the hook's — so the book
   * still turns, your handler still fires, and `page` / `canGoNext` /
   * `visiblePages` quietly stop updating, which kills any button driven by
   * them. It compiled, ran, and looked correct.
   *
   * That cannot happen any more, and the fix is not a rule to remember: the
   * hook SUBSCRIBES TO THE ENGINE DIRECTLY (see the effect below), so its state
   * is correct whether or not these handlers survive the spread. They stay
   * because they make the common case work before the first render commits.
   */
  const bookProps: Pick<
    IEventProps,
    'onPageChange' | 'onPagesChanged' | 'onChangeOrientation' | 'onLoaded' | 'onTurnRejected'
  > & { initialPage: number; hardCovers: boolean } = useMemo(
    () => ({
      onPageChange: apply,
      onPagesChanged,
      // MIN-2. FORWARDED, so the argument reaches the book. It used to seed
      // local state only, and the first `loaded` overwrote it with page 0 —
      // while the comment below implied it drove the engine.
      initialPage,
      hardCovers,
      onLoaded: (snapshot: BookSnapshot) => apply(snapshot, false),
      onChangeOrientation: ({ orientation }) =>
        setState((previous) =>
          withBounds(
            {
              ...previous,
              orientation: orientation === 'portrait' ? 'portrait' : 'landscape',
            },
            ref.current,
          ),
        ),
      // Previously omitted, so an out-of-range page clamped with no signal.
      onTurnRejected,
    }),
    [apply, onPagesChanged, onTurnRejected, initialPage, hardCovers],
  );

  /**
   * The authoritative subscription.
   *
   * `bookProps` can be defeated by prop order — spread it first, pass your own
   * `onPageChange`, and the hook's is overwritten. Everything still LOOKS
   * right: the book turns and your handler fires, while `page`, `canGoNext`
   * and `visiblePages` silently freeze and any button driven by them dies.
   *
   * Listening to the engine itself removes the dependency on prop wiring
   * entirely. It runs once an engine exists — `pageCount` moving off 0 is that
   * signal — and re-subscribes if the engine is replaced.
   */
  // Identity only — subscribe inside the effect to `ref.current`, not this
  // render-time snapshot. A remount can swap the engine between render and
  // the effect flush; binding the snapshot would listen to a destroyed instance
  // and leak the callback if `destroy()` had not yet cleared the map.
  const engine = ref.current?.pageFlip() ?? null;

  useEffect(() => {
    const live = ref.current?.pageFlip() ?? null;
    if (live === null || live.isDestroyed()) return undefined;

    const sync = (): void => {
      if (live.isDestroyed()) return;
      apply(
        {
          page: live.getCurrentPageIndex(),
          pageCount: live.getPageCount(),
          orientation: live.getOrientation(),
          visiblePages: live.getVisiblePages(),
        },
        false,
      );
    };

    live.on('flip', sync);
    live.on('pagesChanged', sync);
    live.on('changeOrientation', sync);
    sync();

    return () => {
      live.off('flip', sync);
      live.off('pagesChanged', sync);
      live.off('changeOrientation', sync);
    };
    // Keyed on the ENGINE's identity, not on pageCount. A remount that keeps
    // the same page count — a `hardCovers` change, say — produced a new engine
    // the old subscription was not attached to, which re-opened the very freeze
    // this effect exists to close.
  }, [apply, engine, state.pageCount]);

  return {
    ref,
    ...state,
    flipNext,
    flipPrev,
    turnToPage,
    flipToPage,
    goToPage,
    bookProps,
  };
}
