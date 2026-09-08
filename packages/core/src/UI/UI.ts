/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PageFlip } from '../PageFlip';
import { PageFlipError } from '../errors';
import { GET_RENDER, GET_COLLECTION, GET_FLIP } from '../internal';
import type { Point } from '../BasicTypes';
import type { FlipSetting } from '../Settings';
import { FlipCorner, FlippingState } from '../Flip/Flip';
import { Orientation } from '../Render/Render';
import { ensureFlipbookStyles } from '../styles';
import { ALL_POINTERS } from '../Settings';
import { FLIPBOOK_INTERACTIVE_SELECTOR } from '../interactive';
import { DROP_POINTER_GESTURE, SET_ORIENTATION_STYLE } from '../internal';
import { ENGINE_LEAF_CLASSES } from '../Page/Page';

type SwipeData = {
  point: Point;
  time: number;
};

/** What a leaf looked like before this UI adopted it. See `adopted`. */
type AdoptedLeaf = {
  /**
   * The leaf's own inline style, captured before any draw.
   *
   * `Page.draw` writes engine style every frame, so by the
   * time a leaf is released the consumer's inline style is gone and cannot be
   * recovered by removing properties — the only way back is the copy taken
   * here. (Historically `HTMLPage.draw` wrote `style.cssText` wholesale.)
   */
  cssText: string;
  /**
   * Engine class names the leaf ALREADY carried at adoption time.
   *
   * `--left` and `--right` are plausible names for a consumer to use, and this
   * engine adds them. Releasing must not strip a class the consumer brought
   * with them, so the ones already present are excluded from the removal.
   */
  preexistingEngineClasses: string[];
  /**
   * Where the leaf was before it was moved into `.stf__block`.
   *
   * X6. `clear()` used to `appendChild` every released leaf onto the host, so a
   * consumer whose own markup follows the pages (a caption, a toolbar, a
   * `<script>`) got the pages silently moved BEHIND it on `destroy()`: sibling
   * combinators and `:last-child` flip, and a re-`loadFromHTML` over the same
   * host picks the pages up in a different order — the book comes back
   * reshuffled. The engine restores what it changed and nothing else (the same
   * contract `UI` honours for the host's inline styles), and position is
   * something it changed.
   *
   * `nextSibling` can itself have moved or been removed by the time the leaf is
   * released, so it is validated at restore time rather than trusted — see
   * `restorePosition`.
   */
  parent: ParentNode | null;
  nextSibling: ChildNode | null;
};

/**
 * UI Class, represents work with DOM.
 * One pointer-event path (mouse, touch, pen) plus ResizeObserver / visualViewport.
 *
 * COLLAPSED from an abstract `UI` plus a single `HTMLUI` subclass. The subclass
 * only added `.stf__block`, leaf adopt/release, and `update()` → render. That is
 * not a renderer seam — it is one DOM host split at an arbitrary line. See
 * `docs/ABSTRACTION-BOUNDARY.md`.
 */
/**
 * How many live engines are mounted on each host element.
 *
 * `stf__parent` is shared state on a node the CONSUMER owns, so removing it is
 * only safe once the last engine using that host has gone. Module-level and
 * `WeakMap`-keyed: no `window`/`document` at module scope (SSR), and a detached
 * host cannot leak. See the constructor.
 */
const hostEngineCount = new WeakMap<HTMLElement, number>();

export class UI {
  private readonly parentElement: HTMLElement;

  private readonly app: PageFlip;
  private readonly wrapper: HTMLElement;
  private distElement!: HTMLElement;

  private items: NodeListOf<HTMLElement> | HTMLElement[];

  /**
   * Leaves this UI moved into `.stf__block` itself, and what they looked like
   * before it did.
   *
   * A leaf that was already inside the block belongs to whoever put it there —
   * React's portal renders its pages straight into it — and `clear()` must
   * leave those alone. Releasing them would move nodes out from under React's
   * recorded parent, and the next removal or reorder throws `NotFoundError`:
   * exactly the failure the portal exists to prevent.
   */
  private readonly adopted = new Map<HTMLElement, AdoptedLeaf>();

  private touchPoint: SwipeData | null = null;
  private readonly swipeTimeout = 250;
  private resizeObserver: ResizeObserver | null = null;
  /** Active pointer id, so `pointerleave` after `pointerup` is ignored. */
  private activePointerId: number | null = null;
  /**
   * Whether `setPointerCapture` actually took for {@link activePointerId}.
   *
   * X5. The capture call is wrapped in a `try`/`catch` because capture is
   * optional — but the id was recorded either way, and `onPointerLeave`
   * returned early whenever an id was set. So on a browser or an element where
   * capture fails (a detached block, a UA that rejects the id, a synthetic
   * pointer with no capture support) the engine believed it was captured:
   * dragging out of the block produced no `pointerup`, no `pointerleave`
   * handling, and the fold stayed on the page following a button-less cursor
   * for the life of the book — the exact bug the capture work was supposed to
   * close, through the door it left open.
   *
   * So the id and the capture are tracked separately: the id says which pointer
   * owns the gesture (I11's filtering), this says whether the browser will keep
   * routing that pointer's events here after it leaves.
   */
  private pointerCaptured = false;
  /**
   * True while `pointerup` / `pointercancel` / `cancelGesture` is releasing
   * capture. `lostpointercapture` fires synchronously from that release and
   * must not treat it as a steal (which would abandon a completed turn).
   */
  private endingPointerGesture = false;
  /** Whether `autoSize` currently owns the host's width / max-width. */
  private autoSizeOwnsHost = false;
  /** Host inline styles captured at construction so `destroy()` can restore them. */
  private readonly hostStyles: {
    minWidth: string;
    minHeight: string;
    width: string;
    maxWidth: string;
    display: string;
  };

  private onResize = (): void => {
    this.update();
  };

  private onVisualViewportResize = (): void => {
    this.update();
  };

  /**
   * Did the caller's host already carry `stf__parent` before we touched it?
   *
   * Only meaningful for the FIRST engine on a given host — see
   * {@link hostEngineCount}.
   */
  private hostHadParentClass = false;
  private hostHadLockTouchScroll = false;

  constructor(
    inBlock: HTMLElement,
    app: PageFlip,
    setting: FlipSetting,
    items: NodeListOf<HTMLElement> | HTMLElement[],
  ) {
    // C5: a strict-CSP host ships the exported stylesheet itself and tells
    // the engine not to try — an injected <style> there is dead on arrival.
    if (setting.injectStyles) ensureFlipbookStyles();

    this.parentElement = inBlock;

    // The host element belongs to the caller (the React tree). Remember what it
    // looked like so `destroy()` hands it back unchanged.
    this.hostStyles = {
      minWidth: inBlock.style.minWidth,
      minHeight: inBlock.style.minHeight,
      width: inBlock.style.width,
      maxWidth: inBlock.style.maxWidth,
      display: inBlock.style.display,
    };

    // REFERENCE COUNTED, because a boolean per instance answers the wrong
    // question. The first engine on a host records `false` and the second
    // records `true` — so destroying the FIRST removed the class from a host
    // the second is still rendering into, and the book lost its positioning
    // context while live. That is the exact multi-mount case the comment below
    // named as the motivation, which the boolean did not survive.
    //
    // A module-level `WeakMap` rather than a counter attribute on the element:
    // the count is the engine's bookkeeping, not something a consumer should
    // find in their DOM, and a `WeakMap` keyed on the host cannot leak a
    // detached node.
    const engines = hostEngineCount.get(inBlock) ?? 0;
    hostEngineCount.set(inBlock, engines + 1);

    // Record whether the caller already had it, for the same reason the styles
    // above are recorded: `destroy()` promises to hand the host back UNCHANGED,
    // and it used to remove this class unconditionally. A consumer who styles
    // their own container with `stf__parent` — or who mounts two books through
    // one wrapper — had a class they own stripped by a teardown that was only
    // supposed to undo its own work.
    //
    // Only the first arrival can observe the pre-existing state; every later
    // one sees the class the earlier engine added.
    this.hostHadParentClass = engines === 0 && inBlock.classList.contains('stf__parent');
    this.hostHadLockTouchScroll =
      engines === 0 && inBlock.classList.contains('--lock-touch-scroll');
    inBlock.classList.add('stf__parent');
    inBlock.insertAdjacentHTML('afterbegin', '<div class="stf__wrapper"></div>');

    this.wrapper = inBlock.querySelector('.stf__wrapper') as HTMLElement;

    this.app = app;

    this.applyHostSize(setting);

    this.observeResize();

    // Second wrapper to HTML page
    this.wrapper.insertAdjacentHTML('afterbegin', '<div class="stf__block"></div>');

    const block = inBlock.querySelector('.stf__block');
    if (!block) {
      throw new PageFlipError('HTML block missing', 'RENDER_SETUP');
    }
    const dist = block as HTMLElement;
    this.distElement = dist;

    this.items = items;
    for (const item of items) {
      this.adopt(item);
    }

    this.setHandlers();
  }

  /**
   * Stamp the host element's sizing constraints from the current settings.
   *
   * Also called on `updateSettings`, so a responsive `width` / `height` is a
   * restyle rather than a teardown. Without this the React binding had to
   * treat size as constructor-only and rebuild the whole engine on every
   * resize step — losing the current page and any in-flight turn.
   *
   * @internal Wiring seam for `PageFlip.updateSettings`. Not part of the
   * supported API; it may change in a minor release.
   */
  public applyHostSize(setting: FlipSetting = this.app.getSettings()): void {
    const host = this.parentElement;
    // Y5. Read from the PARAMETER, like every other value here. This used to
    // reach past it to `this.app.getSettings()`, which happens to be the same
    // object today only because `updateSettings` mutates in place — the same
    // class of bug as the cached `swipeDistance`, inverted: there a value was
    // frozen at construction, here a parameter is ignored in favour of live
    // state. A caller handing in a different settings object (a preview of a
    // pending change, a test) got `minWidth` computed for the wrong
    // orientation, so a landscape book was stamped with a single page's
    // minimum width.
    const k = setting.usePortrait ? 1 : 2;

    host.style.minWidth = `${setting.minWidth * k}px`;
    host.style.minHeight = `${setting.minHeight}px`;

    if (setting.autoSize) {
      host.style.width = '100%';
      // `* 2`, NOT `* k`, and the asymmetry with `minWidth` above is the point.
      //
      // `k` answers "how narrow may this book legally be", and `usePortrait`
      // genuinely lowers that floor to a single leaf. The CEILING is two leaves
      // whatever `usePortrait` says, because portrait is not a mode a book is
      // put into — it is what `Render.computeBounds` decides while the block is
      // NARROW (`blockWidth < minWidth * 2`). A `usePortrait` book on a wide
      // screen is landscape, and landscape wants `2 * maxWidth`.
      //
      // Applying `k` here does not tighten the bound, it deletes landscape: the
      // host can no longer reach the width at which the book would flip to two
      // pages. With `minWidth: 400, maxWidth: 600` the ceiling becomes 600px
      // against a 800px threshold, so the book is pinned to one leaf on a 4K
      // display — measured, and pinned by the W1 tests in
      // `packages/core/tests/ui-pointer.test.ts`.
      host.style.maxWidth = `${setting.maxWidth * 2}px`;
    } else if (this.autoSizeOwnsHost) {
      // Only on the transition out of autoSize: hand back what it took over.
      // Doing this on every settings update would clobber a width the caller
      // set themselves after construction.
      host.style.width = this.hostStyles.width;
      host.style.maxWidth = this.hostStyles.maxWidth;
    }

    this.autoSizeOwnsHost = setting.autoSize;

    host.classList.toggle('--lock-touch-scroll', setting.allowTouchScroll === false);

    // U9. `host.style.display = 'block'` used to run here, on construction AND
    // on every `updateSettings`. It was redundant and actively harmful:
    // `.stf__parent` already declares `display:block` (styles.ts), so the class
    // does the job — while the INLINE write outranks the consumer's own
    // stylesheet, which the class does not. A consumer styling their host
    // `display: flex` for their own toolbar or caption layout was silently
    // reset, and reset again on every runtime settings change, with no way to
    // win: `width` and `maxWidth` are guarded by `autoSizeOwnsHost` precisely
    // so a caller-set value survives, and `display` had no such guard.
    //
    // `hostStyles.display` is still recorded and still restored by `destroy()`.
    // Nothing writes it today, so the restore is a no-op — it stays so that
    // re-adding a write cannot land without its matching restore.

    this.applyWrapperRatio();
  }

  /**
   * The wrapper reserves the book's aspect ratio with bottom padding. It is
   * derived from width/height, so a live size change has to recompute it —
   * otherwise a 300×400 book resized to 320×400 keeps 133.33% and renders at
   * the old proportions.
   *
   * NOT gated on `autoSize` (W2). `autoSize: false` means the engine does not
   * own the HOST's width — it was never a statement about the engine's own
   * wrapper, which no consumer can reasonably be asked to style. Upstream
   * gated this and so collapsed the wrapper to zero height whenever a
   * consumer sized the host themselves; `Render` then centred the book on the
   * wrapper's top EDGE (`top: -height/2`) and the book drew half out of
   * frame. The old story-book reader hid exactly this inside the
   * monkey-patch layer this fork exists to delete.
   */
  private applyWrapperRatio(orientation?: Orientation): void {
    const setting = this.app.getSettings();

    // The constructor runs before the render exists. Skipping is safe there:
    // `render.start()` calls `update()`, which reports the orientation back
    // through `setOrientationStyle` and lands here with a real value.
    const resolved = orientation ?? this.currentOrientation();
    if (resolved === null) return;

    const spreadWidth = resolved === Orientation.PORTRAIT ? setting.width : setting.width * 2;

    this.wrapper.style.paddingBottom = `${(setting.height / spreadWidth) * 100}%`;
  }

  /**
   * Book orientation, or `null` before a render exists.
   *
   * `UI` is constructed before `attachMode` wires up the render, so this runs
   * with nothing behind it during construction. The controller is set in the
   * same step as the render, so asking whether it exists is the same question
   * — and unlike catching, it cannot swallow a real fault by accident.
   */
  private currentOrientation(): Orientation | null {
    if (this.app[GET_FLIP]() === null) return null;

    return this.app[GET_RENDER]().getOrientation();
  }

  public destroy(): void {
    this.removeHandlers();
    this.unobserveResize();

    // `distElement` is `.stf__block` in HTML mode, and it holds the page
    // elements the engine ADOPTED from the caller. Removing the block with
    // them still inside deletes the consumer's own DOM: a vanilla book that
    // is destroyed and re-created (hot reload, mode switch, route remount)
    // came back empty. Hand the adopted leaves back first.
    this.releaseNodes();

    this.distElement.remove();
    this.wrapper.remove();

    // Hand the host element back the way we found it.
    const remaining = (hostEngineCount.get(this.parentElement) ?? 1) - 1;
    if (remaining > 0) {
      hostEngineCount.set(this.parentElement, remaining);
    } else {
      hostEngineCount.delete(this.parentElement);
      // Last one out. Only now is it safe to ask whether the class was ours.
      if (!this.hostHadParentClass) this.parentElement.classList.remove('stf__parent');
      if (!this.hostHadLockTouchScroll) {
        this.parentElement.classList.remove('--lock-touch-scroll');
      }
    }
    this.parentElement.style.minWidth = this.hostStyles.minWidth;
    this.parentElement.style.minHeight = this.hostStyles.minHeight;
    this.parentElement.style.width = this.hostStyles.width;
    this.parentElement.style.maxWidth = this.hostStyles.maxWidth;
    this.parentElement.style.display = this.hostStyles.display;
  }

  /**
   * Hand back caller-owned nodes this UI moved into `distElement`, before the
   * block is removed in `destroy()`.
   *
   * `clear()` moves exactly the leaves this UI adopted and leaves everything
   * else (React's portalled pages, the render's shadows) where it found them.
   */
  private releaseNodes(): void {
    this.clear();
  }

  /**
   * Hand the adopted leaves back to the host, undressed.
   *
   * U1. Returning the nodes was only half of it: the page class had stamped them
   * as engine leaves — `stf__item`, `--soft`/`--hard`, `--left`/`--right`,
   * `--simple`, plus engine inline style written by `draw`. A vanilla consumer
   * who destroys the book and re-renders their own markup got a stack of
   * absolutely positioned, clip-pathed pages piled on the origin.
   *
   * The engine restores what it changed and nothing else — the same contract
   * it already honours for the HOST element's inline styles — but the two
   * halves are restored differently, deliberately:
   *
   * - **Inline style is restored wholesale** from the snapshot taken at
   *   adoption. `draw` replaces engine declarations on every frame, so a live
   *   leaf cannot be carrying a consumer inline style the engine overwrote
   *   without a snapshot; there is nothing to preserve and nothing to merge.
   *   Stripping "only the properties `draw` writes" would leave `simpleDraw`'s
   *   and `drawHard`'s different property sets to track separately, and would
   *   still not put back what `draw` destroyed.
   * - **Classes are removed selectively**, never restored wholesale. The engine
   *   only ever ADDS classes here, and a consumer may legitimately toggle their
   *   own on a live leaf (`.is-current`, an animation hook); resetting
   *   `className` to the adoption-time value would silently discard those. So
   *   exactly the engine's own class names come off — minus any the leaf
   *   already had when it was adopted.
   */
  public clear(): void {
    // Hand back only what we took, to WHERE we took it from. See `adopted`.
    //
    // Reverse order, and that is load-bearing: consecutive pages are each
    // other's recorded `nextSibling`, and while they are still inside the block
    // that sibling is not back in the host yet. Restoring last-to-first means
    // every leaf's anchor is already in place when its turn comes — the last
    // page anchors against the consumer's own trailing markup, the one before
    // it against the last page, and so on. Front-to-back, every anchor but the
    // first is still missing and the whole run degrades to an append.
    for (const [item, original] of Array.from(this.adopted).reverse()) {
      this.undress(item);
      this.restorePosition(item, original);
    }

    this.adopted.clear();
  }

  /**
   * Put one released leaf back where it was adopted from.
   *
   * The recorded anchor is verified, never trusted: between adoption and
   * release the consumer may have removed the following sibling, moved it, or
   * emptied the original parent entirely. Each fallback is one step weaker than
   * the last: the exact slot, then the end of the original parent, then — only
   * for a leaf that was detached when it was adopted, and so has nowhere to go
   * back to — the old behaviour of appending to the host.
   */
  private restorePosition(item: HTMLElement, original: AdoptedLeaf): void {
    const { parent, nextSibling: anchor } = original;

    if (parent === null) {
      this.parentElement.appendChild(item);
      return;
    }

    if (anchor !== null && anchor.parentNode === parent) {
      parent.insertBefore(item, anchor);
      return;
    }

    parent.appendChild(item);
  }

  /**
   * Undo the engine's styling of one adopted leaf. See `clear()` for why the
   * inline style is restored but the classes are only subtracted. No-op for a
   * node this UI never adopted.
   */
  private undress(item: HTMLElement): void {
    const original = this.adopted.get(item);
    if (original === undefined) return;

    item.style.cssText = original.cssText;

    for (const name of ENGINE_LEAF_CLASSES) {
      if (!original.preexistingEngineClasses.includes(name)) item.classList.remove(name);
    }
  }

  /**
   * Move a leaf into the block, remembering that we were the one who moved it
   * and what it looked like beforehand.
   *
   * The snapshot has to be taken HERE, before the leaf is ever drawn: `draw()`
   * overwrites engine style on the first frame, so anything captured later is
   * the engine's own styling, not the consumer's.
   */
  private adopt(item: HTMLElement): void {
    const dist = this.distElement;
    if (item.parentElement === dist) return;

    if (!this.adopted.has(item)) {
      this.adopted.set(item, {
        cssText: item.style.cssText,
        preexistingEngineClasses: ENGINE_LEAF_CLASSES.filter((name) =>
          item.classList.contains(name),
        ),
        // Captured HERE for the same reason the inline style is: after
        // `appendChild` below the node's neighbours are the engine's, not the
        // consumer's, and the original position is unrecoverable.
        parent: item.parentNode,
        nextSibling: item.nextSibling,
      });
    }

    dist.appendChild(item);
  }

  /**
   * Update page list from HTMLElements
   *
   * @param {(NodeListOf<HTMLElement>|HTMLElement[])} items - List of pages as HTML Element
   */
  public updateItems(items: NodeListOf<HTMLElement> | HTMLElement[]): void {
    this.removeHandlers();

    const next = new Set<HTMLElement>(items);

    // Drop only the leaves we adopted last time. `innerHTML = ''` also wiped
    // the render's shadow elements, and it deletes nodes a framework may
    // still consider its own (React portals its pages in here).
    for (const previous of Array.from(this.items)) {
      // Only leaves we adopted are ours to delete. A framework that rendered
      // its page into the block still owns that node — removing it here is the
      // same stale-parent failure `clear()` used to cause, just on the other
      // side of the lifecycle. React removes its own pages; we must not.
      if (!next.has(previous) && this.adopted.has(previous)) {
        // Undress before dropping it: the consumer handed this node over and
        // may well keep and reuse it, and a detached node still carrying
        // `position:absolute` and a `clip-path` is the same U1 failure as one
        // handed back by `clear()`.
        this.undress(previous);
        previous.remove();
        this.adopted.delete(previous);
      }
    }

    for (const item of items) {
      this.adopt(item);
    }

    this.items = items;

    this.setHandlers();

    // B3.1: adopt/release may restore consumer cssText or bring a leaf whose
    // inline styles changed while the engine was not looking. Bust every
    // leaf memo so the next draw re-stamps (no-op if the collection is empty
    // mid-updateFromHtml — new Pages start with a fresh cache anyway).
    if (!this.app.isDestroyed()) {
      try {
        this.app[GET_COLLECTION]().invalidateDrawCache();
      } catch {
        // NOT_LOADED
      }
    }
  }

  public update(): void {
    this.app[GET_RENDER]().update();
  }

  /**
   * Rebind input handlers after `updateSettings({ pointerInput })`.
   *
   * `keepFold` is for the geometry+pointer combined path: the fold was already
   * abandoned against the NEW box, and a nested `flipNext` from that
   * `changeState` must not be killed by a second `cancelGesture`. Pointer
   * bookkeeping still drops — the listeners are going away.
   */
  public refreshHandlers(options?: { keepFold?: boolean }): void {
    if (options?.keepFold === true) {
      this.endingPointerGesture = true;
      try {
        this[DROP_POINTER_GESTURE]();
      } finally {
        this.endingPointerGesture = false;
      }
      this.unbindPointerListeners();
    } else {
      this.removeHandlers();
    }
    this.setHandlers();
  }

  public getDistElement(): HTMLElement {
    return this.distElement;
  }

  public getWrapper(): HTMLElement {
    return this.wrapper;
  }

  public [SET_ORIENTATION_STYLE](orientation: Orientation): void {
    this.wrapper.classList.remove('--portrait', '--landscape');
    this.wrapper.classList.add(orientation === Orientation.PORTRAIT ? '--portrait' : '--landscape');

    this.applyWrapperRatio(orientation);
    this.update();
  }

  private unbindPointerListeners(): void {
    this.distElement.removeEventListener('pointerdown', this.onPointerDown);
    this.distElement.removeEventListener('pointermove', this.onPointerMove);
    this.distElement.removeEventListener('pointerup', this.onPointerUp);
    this.distElement.removeEventListener('pointercancel', this.onPointerCancel);
    this.distElement.removeEventListener('pointerleave', this.onPointerLeave);
    this.distElement.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    this.distElement.removeEventListener('dragstart', this.onDragStart);
  }

  private removeHandlers(): void {
    // Unbinding can happen in the middle of a gesture — `refreshHandlers` from
    // `updateSettings({ pointerInput })`, and `updateItems`. The real
    // `pointerup` then lands on nothing, so the gesture has to be ended here
    // or the engine stays in `USER_FOLD` with `isUserTouch` set and the fold
    // follows a button-less cursor forever.
    this.cancelGesture();
    this.unbindPointerListeners();
  }

  private setHandlers(): void {
    // X7. Suppressing the native drag ghost is NOT a mouse-input feature, and
    // it used to sit behind this early return: with `useMouseEvents: false` the
    // engine turns off page turning by pointer, but the browser still starts
    // its own image / text drag inside a page — a translucent copy of the
    // artwork peeling away from a book that has deliberately disabled dragging.
    // Bound before the return, removed unconditionally in `removeHandlers`.
    this.distElement.addEventListener('dragstart', this.onDragStart);

    // D2. `pointerInput` is filtered PER POINTER at the entry points below, not
    // by refusing to register at all. Gating registration on the array being
    // non-empty is what the old boolean did, and it is the same defect wearing
    // the new name: `pointerInput: ['touch']` would register the one path and
    // then let mouse and pen turn the book exactly as before.
    //
    // The empty case still short-circuits, because "no pointer may turn this
    // book" needs no listeners at all.
    if (this.app.getSettings().pointerInput.length === 0) return;

    // `preventDefault` on touch pointerdown/move is a no-op in a passive
    // listener. iOS Safari treats unspecified as passive for touch-derived
    // pointer events; `{passive:false}` is what makes `allowTouchScroll: false`
    // actually suppress scrolling.
    const pointerListen: AddEventListenerOptions = { passive: false };
    this.distElement.addEventListener('pointerdown', this.onPointerDown, pointerListen);
    this.distElement.addEventListener('pointermove', this.onPointerMove, pointerListen);
    this.distElement.addEventListener('pointerup', this.onPointerUp);
    this.distElement.addEventListener('pointercancel', this.onPointerCancel);
    this.distElement.addEventListener('pointerleave', this.onPointerLeave);
    // The browser can take a capture away mid-gesture (a `pointercancel`, the
    // element being removed, an OS gesture claiming the pointer). After that
    // the events stop coming here, so the gesture is in the same position as
    // one that never captured at all — see `pointerCaptured`.
    this.distElement.addEventListener('lostpointercapture', this.onLostPointerCapture);
  }

  private observeResize(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(this.parentElement);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onResize, false);
    }

    if (typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.addEventListener('resize', this.onVisualViewportResize);
      window.visualViewport.addEventListener('scroll', this.onVisualViewportResize);
    }
  }

  private unobserveResize(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    } else if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onResize);
    }

    if (typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this.onVisualViewportResize);
      window.visualViewport.removeEventListener('scroll', this.onVisualViewportResize);
    }
  }

  /**
   * Pointer position in book space. RTL must NOT mirror x here: the fold has to
   * follow the finger. Reading direction is applied to the *turn direction*
   * only — `Flip.getDirectionByPoint` for drag/click, `swipeDirection` below
   * for swipes.
   *
   * U3 / I14 — the third instance of one bug class, and the only one that needs
   * a CONVERSION rather than a change of ruler.
   *
   * Three coordinate spaces meet here:
   *
   *  - the pointer arrives in **client (visual) pixels** — that is all a
   *    `PointerEvent` has, and it is measured through every ancestor transform;
   *  - `getBoundingClientRect()` is likewise **transform-aware**, so it is the
   *    right thing to locate the block's origin *in that same space*;
   *  - but `Render` measures the book with `offsetWidth` / `offsetHeight`
   *    ({@link Render.getBlockWidth}), which is **transform-blind** — pure
   *    layout pixels. Every rect, page width and fold vertex downstream is in
   *    layout pixels.
   *
   * Subtracting `rect.left` alone therefore produced a *visual*-pixel offset
   * and handed it to layout-pixel geometry. At scale 1 the two spaces coincide,
   * which is exactly why this survived; inside any `transform: scale()`
   * ancestor — a zoom-to-fit shell, a responsive wrapper, a slide deck — the
   * fold tracked the finger at the wrong ratio, and the error grows with the
   * distance from the block's origin, so it is worst at the outer edge where
   * folds actually start.
   *
   * A backing-store path that measures *the element* can pick the layout box
   * and stop. That option does not exist here: the input genuinely is a
   * visual-pixel point, so the choice is not which box to measure but which
   * space to end up in — and it must be `Render`'s. Hence: locate the origin
   * with the
   * transform-aware rect (same space as the pointer), then divide by the
   * visual-per-layout ratio of the very same element. **Output is layout
   * pixels, relative to `distElement`** — the space `Render.convertToBook`
   * expects.
   *
   * `offsetWidth`, not `getComputedStyle().width`, is the denominator on
   * purpose: the aim is not the truest layout box but *the one `Render` uses*.
   * Where the two differ (offset* is rounded to an integer) matching `Render`
   * is what keeps the block's far edge in pointer space equal to the block's
   * far edge in geometry space.
   *
   * Both axes are derived independently — a non-uniform `scale(sx, sy)` is
   * legal CSS — and a zero or missing measurement (a hidden book, jsdom's
   * unlaid-out DOM) falls back to 1:1 rather than dividing by zero.
   *
   * **Known limitation: translation and scale only.** `getBoundingClientRect()`
   * returns the axis-aligned *bounding* box, so under an ancestor `rotate()` or
   * `skew()` neither half of this holds: `rect.width / offsetWidth` is a
   * cos/sin mix rather than a scale factor, and `rect.left/top` is a corner of
   * the bounding box rather than the element's origin. A rotated book therefore
   * folds away from the finger. Correcting it needs the accumulated ancestor
   * matrix and a `DOMMatrix` inversion — several hundred bytes of engine to
   * serve a case no consumer has asked for, against a fork whose size ceiling is
   * already the binding constraint. Stated rather than fixed; reopen it if a
   * real book is ever rendered on a rotated surface.
   */
  private getMousePos(x: number, y: number): Point {
    const el = this.distElement;
    const rect = el.getBoundingClientRect();

    const layoutWidth = el.offsetWidth;
    const layoutHeight = el.offsetHeight;

    const scaleX = layoutWidth > 0 && rect.width > 0 ? rect.width / layoutWidth : 1;
    const scaleY = layoutHeight > 0 && rect.height > 0 ? rect.height / layoutHeight : 1;

    return {
      x: (x - rect.left) / scaleX,
      y: (y - rect.top) / scaleY,
    };
  }

  private checkTarget(targer: EventTarget | null): boolean {
    if (!this.app.getSettings().respectInteractiveContent) return true;
    if (!(targer instanceof Element)) return true;
    return targer.closest(FLIPBOOK_INTERACTIVE_SELECTOR) === null;
  }

  /** Release pointer capture and forget the active pointer. Idempotent. */
  private releaseCapturedPointer(): void {
    if (this.activePointerId === null) return;

    // Every engine-initiated release fires `lostpointercapture` synchronously.
    // That must not look like an OS steal (`cancelGesture` → second `abandon`
    // that kills a nested `flipNext` from the first READ).
    const ownedEnd = !this.endingPointerGesture;
    this.endingPointerGesture = true;
    try {
      this.distElement.releasePointerCapture(this.activePointerId);
    } catch {
      // already released
    } finally {
      this.activePointerId = null;
      this.pointerCaptured = false;
      if (ownedEnd) this.endingPointerGesture = false;
    }
  }

  /**
   * Drop the swipe anchor and the captured pointer. See
   * {@link DROP_POINTER_GESTURE}. Idempotent.
   *
   * @internal — symbol-keyed, unreachable by name from outside the package.
   */
  public [DROP_POINTER_GESTURE](): void {
    this.touchPoint = null;
    this.releaseCapturedPointer();
  }

  /**
   * End an in-flight gesture without committing anything.
   *
   * Releasing the capture is not enough: `PageFlip.isUserTouch` and the fold
   * state live in the engine, and only a `pointerup` clears them. `userStop`
   * with `isSwipe` set unwinds the touch flag while deliberately committing
   * neither a click-turn nor a snap-back — the gesture is being abandoned, not
   * finished — and `abandon()` drops the fold and returns the state to READ,
   * the same pairing `PageFlip.replacePages` uses when pages vanish under a
   * gesture. Idempotent: a no-op when nothing is in flight.
   */
  private cancelGesture(): void {
    // NOTE the coupling C1 introduced: `resetUserGesture()` now clears both of
    // these, so any path that resets BEFORE reaching here finds `wasActive`
    // false and skips the `userStop` / `abandon()` / `show()` tail below.
    // Traced at the time for the one path where that happens —
    // `updateFromHtml` -> `updateItems` -> `removeHandlers` — and all three are
    // already no-ops there, because the same tail ran on the engine side a
    // moment earlier. Pinned here rather than left implicit: a future tail that
    // is NOT idempotent would be silently skipped, and nothing else in the file
    // would say why.
    const ownedEnd = !this.endingPointerGesture;
    this.endingPointerGesture = true;
    try {
      const wasActive = this.touchPoint !== null || this.activePointerId !== null;
      const lastPos = this.touchPoint?.point ?? { x: 0, y: 0 };

      this[DROP_POINTER_GESTURE]();

      if (!wasActive) return;

      // The controller is the witness that a mode is attached: it and the page
      // collection are wired in the same step, so this also proves `show()`
      // below has something to draw and cannot throw `NOT_LOADED`.
      const flip = this.app[GET_FLIP]();
      if (flip === null) return;

      this.app.userStop(lastPos, true);
      flip.abandon();

      // Repaint the spread: the last frame drawn was a fold that no longer
      // exists. Skipped during teardown, where there is nothing left to draw to.
      if (!this.app.isDestroyed()) this.app[GET_COLLECTION]().show();
    } finally {
      if (ownedEnd) this.endingPointerGesture = false;
    }
  }

  private swipeDirection(dx: number): 'prev' | 'next' {
    const rtl = this.app.getSettings().readingDirection === 'rtl';

    if (dx > 0) {
      return rtl ? 'next' : 'prev';
    }

    return rtl ? 'prev' : 'next';
  }

  private onDragStart = (e: DragEvent): void => {
    e.preventDefault();
  };

  /**
   * The browser took the capture back mid-gesture.
   *
   * A release from our own `pointerup` / `pointercancel` / `cancelGesture`
   * fires this synchronously — those paths already end the gesture. A steal
   * with no following leave/up/cancel (iOS taking the pan) used to leave
   * `USER_FOLD` for the life of the book. That steal is `pointercancel`:
   * abandon, never swipe-commit.
   */
  private onLostPointerCapture = (e: PointerEvent): void => {
    if (this.activePointerId !== e.pointerId) return;

    this.pointerCaptured = false;
    if (this.endingPointerGesture) return;
    this.cancelGesture();
  };

  /**
   * Pointer left the book without a release.
   *
   * Three cases, and the middle one is X5:
   *
   * - **No gesture** — a hover walked off the book; put the hover corner back.
   * - **A gesture we do NOT hold the capture for** — no `pointerup` will ever
   *   reach this element again, so this is the last event of the gesture. It
   *   has to end here, without committing (the pointer left the book; that is
   *   an abandonment, not a turn) or the engine stays in `USER_FOLD` with the
   *   fold following a button-less cursor forever.
   * - **A captured gesture** — skipped. Under capture `pointerleave` also fires
   *   straight after `pointerup` (always so for touch), and re-entering
   *   `stopMove()` there starts a second snap-back over the one `userStop`
   *   already began.
   *
   * Y3. `pointerleave` is dispatched PER POINTER ID, so this needs the same
   * ownership filter every other handler applies. Without it this was the one
   * input handler any pointer could drive: a hover mouse on a hybrid device,
   * or a stray finger, entering and leaving the block while a drag was in
   * flight landed in the uncaptured branch and abandoned the OWNING
   * pointer's gesture. (`isActivePointer` also passes the no-gesture case
   * through, which is the hover branch below.)
   */
  private onPointerLeave = (e: PointerEvent): void => {
    if (!this.isActivePointer(e)) return;

    if (this.activePointerId !== null) {
      if (this.pointerCaptured) return;

      this.cancelGesture();
      return;
    }

    this.touchPoint = null;

    this.unfoldHoverCorner();
  };

  /** Put a hover-folded corner back. Only the hover fold — never a drag. */
  private unfoldHoverCorner(): void {
    const flip = this.app[GET_FLIP]();

    if (flip?.getState() === FlippingState.FOLD_CORNER) {
      this.app[GET_RENDER]().finishAnimation();
      flip.stopMove();
    }
  }

  /**
   * Does this event belong to the gesture in progress?
   *
   * With no active pointer there is no gesture to belong to — that is a hover,
   * which every pointer may drive. Once one pointer owns the gesture, the
   * others are ignored: a second finger used to overwrite `activePointerId`
   * (orphaning the first pointer's capture) and then drive the fold, so a
   * two-finger pinch-zoom over the book folded a page and lifting either
   * finger ran `userStop` — committing a turn nobody asked for.
   */
  private isActivePointer(e: PointerEvent): boolean {
    return this.activePointerId === null || this.activePointerId === e.pointerId;
  }

  /**
   * Does `pointerInput` admit this device?
   *
   * `PointerEvent.pointerType` is `'mouse' | 'pen' | 'touch'` in practice, but
   * the spec allows a UA-specific string, and an unrecognised device must not
   * be silently dropped — a book that cannot be turned by hardware nobody
   * anticipated is a worse failure than one extra accepted pointer. So an
   * unknown type is admitted whenever the consumer has not narrowed the list.
   */
  private acceptsPointer(e: PointerEvent): boolean {
    const allowed = this.app.getSettings().pointerInput;
    const kind = e.pointerType;

    if (kind === 'mouse' || kind === 'touch' || kind === 'pen') return allowed.includes(kind);

    // SET membership, not array length. `['touch','touch','touch']` has
    // length 3, so a length test read a deliberately narrowed policy as "all
    // pointers" and admitted an unrecognised device the consumer had excluded.
    return ALL_POINTERS.every((kind) => allowed.includes(kind));
  }

  private onPointerDown = (e: PointerEvent): void => {
    // A gesture is already in progress and belongs to another pointer.
    if (this.activePointerId !== null) return;
    if (!this.acceptsPointer(e)) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (!this.checkTarget(e.target)) return;

    const pos = this.getMousePos(e.clientX, e.clientY);

    this.activePointerId = e.pointerId;
    this.pointerCaptured = false;

    try {
      this.distElement.setPointerCapture(e.pointerId);
      // Ask rather than assume. A UA that implements capture can still decline
      // this particular one (a pointer that is no longer active, an element
      // just detached) WITHOUT throwing, and believing the call is the same
      // failure as swallowing the throw was. Written against the runtime value
      // because `lib.dom` declares the query as always present: where it is
      // missing — jsdom, older UAs — a bare call would throw into the `catch`
      // below and report every capture as failed, so a call that did not throw
      // is the best evidence available there.
      this.pointerCaptured =
        typeof this.distElement.hasPointerCapture === 'function'
          ? this.distElement.hasPointerCapture(e.pointerId)
          : true;
    } catch {
      // Capture is optional. The id is still tracked, so this pointer owns the
      // gesture and others are filtered out — but `pointerleave` must now treat
      // leaving the block as the end of it. See `pointerCaptured`.
      this.pointerCaptured = false;
    }

    this.touchPoint = {
      point: pos,
      time: Date.now(),
    };

    this.app.startUserTouch(pos);

    // Do not preventDefault on pointerdown when locked: that is the first
    // finger of a pinch, and `{passive:false}` would cancel WCAG 1.4.4 zoom.
    // Pan is suppressed by `--lock-touch-scroll { touch-action: pinch-zoom }`.
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.isActivePointer(e)) return;
    // Also the HOVER peel: without this a disallowed mouse could not start a
    // turn but could still fold a corner up, which reads as a book that half
    // responds to it.
    if (!this.acceptsPointer(e)) return;

    // The `clickEventForward` guard ran on `pointerdown` only, so the click
    // was forwarded correctly while the *hover* still folded the corner up
    // over the link or button the user was reaching for. A hover that lands on
    // an interactive target unfolds instead — the same thing leaving the book
    // does. Only hovers: a drag under capture reports the block as its target
    // and must keep following the finger.
    if (this.activePointerId === null && !this.checkTarget(e.target)) {
      this.unfoldHoverCorner();
      return;
    }

    const pos = this.getMousePos(e.clientX, e.clientY);
    const isTouch = e.pointerType !== 'mouse';

    if (this.app.getSettings().allowTouchScroll && isTouch) {
      if (this.touchPoint !== null) {
        if (
          Math.abs(this.touchPoint.point.x - pos.x) > 10 ||
          this.app.getState() !== FlippingState.READ
        ) {
          this.app.userMove(pos, true);
        }
      }

      if (this.app.getState() !== FlippingState.READ) {
        if (e.cancelable) e.preventDefault();
      }
    } else {
      this.app.userMove(pos, isTouch);
      // Only once a fold is live — preventDefault on every locked move cancels
      // pinch-zoom. CSS `touch-action: pinch-zoom` already blocks pan.
      if (
        !this.app.getSettings().allowTouchScroll &&
        isTouch &&
        this.app.getState() !== FlippingState.READ &&
        e.cancelable
      ) {
        e.preventDefault();
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    // Lifting a finger that never owned the gesture must not end it.
    if (!this.isActivePointer(e)) return;

    this.endingPointerGesture = true;
    try {
      this.releaseCapturedPointer();
      const pos = this.getMousePos(e.clientX, e.clientY);
      let isSwipe = false;

      if (this.touchPoint !== null) {
        const dx = pos.x - this.touchPoint.point.x;
        const distY = Math.abs(pos.y - this.touchPoint.point.y);
        // Read live: caching this at construction meant `updateSettings` was
        // accepted and reported back by `getSettings()` while the gesture kept
        // using the old threshold.
        const { swipeDistance } = this.app.getSettings();

        if (
          Math.abs(dx) > swipeDistance &&
          distY < swipeDistance * 2 &&
          Date.now() - this.touchPoint.time < this.swipeTimeout
        ) {
          // `touchPoint.point` is relative to `distElement`; `rect.height` is the
          // book's. Comparing them directly ignored `rect.top`, so on a book
          // centred in a taller host every upper-half swipe was classified
          // BOTTOM. `Flip.start` converts first — this call site was the odd one
          // out. (`>=` matches `Flip.start`'s split exactly.)
          const render = this.app[GET_RENDER]();
          const bookPos = render.convertToBook(this.touchPoint.point);
          const corner =
            bookPos.y >= render.getRect().height / 2 ? FlipCorner.BOTTOM : FlipCorner.TOP;

          if (this.swipeDirection(dx) === 'prev') {
            this.app.flipPrev(corner);
          } else {
            this.app.flipNext(corner);
          }
          isSwipe = true;
        }

        this.touchPoint = null;
      }

      this.app.userStop(pos, isSwipe);
    } finally {
      this.endingPointerGesture = false;
    }
  };

  /**
   * U2. The OS took the pointer away — a system back-swipe, a browser gesture
   * takeover, palm rejection, the pointer's device being removed.
   *
   * This was bound to `onPointerUp`, which runs the swipe branch: a fast
   * cancelled drag met the distance / time thresholds and COMMITTED the turn
   * the user's gesture had just been aborted out of. A cancellation is the
   * platform telling us the gesture never happened; it must abandon, never
   * commit.
   *
   * It reuses `cancelGesture()` rather than growing a second cancel path: the
   * semantics wanted here are exactly the ones that path already implements —
   * release the capture, unwind `PageFlip.isUserTouch` without committing a
   * click-turn or a snap-back, drop the fold, repaint the spread. The only
   * things that differ are entry conditions, and those belong at the handler:
   * a cancel from a pointer that never owned the gesture must not end it, and a
   * cancelled *hover* has no gesture to abandon but may have left a corner
   * folded up.
   */
  private onPointerCancel = (e: PointerEvent): void => {
    if (!this.isActivePointer(e)) return;

    if (this.activePointerId === null && this.touchPoint === null) {
      this.unfoldHoverCorner();
      return;
    }

    this.cancelGesture();
  };
}
