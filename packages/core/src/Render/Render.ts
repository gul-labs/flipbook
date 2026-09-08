/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { at } from '../arrayAccess';
import { GET_UI, GET_COLLECTION, ADOPT_ORIENTATION, INVALIDATE_FOLD_GEOMETRY } from '../internal';
import type { PageFlip } from '../PageFlip';
import type { Point, PageRect, RectPoints } from '../BasicTypes';
import { FlipDirection } from '../Flip/Flip';
import type { Page } from '../Page/Page';
import { PageDensity, PageOrientation } from '../Page/Page';
import type { FlipSetting } from '../Settings';
import { SizeMode } from '../Settings';
import { convertPageToGlobal } from '../geometry';
import { rotatePoint } from '../Helper';
import { PageFlipError } from '../errors';
import { shouldDrawBottomPage } from './bottomPage';

type FrameAction = () => void;
type AnimationSuccessAction = () => void;

/**
 * Type describing calculated values for drop shadows
 */
export type Shadow = {
  /** Shadow Position Start Point */
  pos: Point;
  /** The angle of the shadows relative to the book */
  angle: number;
  /** Base width shadow */
  width: number;
  /** Base shadow opacity */
  opacity: number;
  /** Flipping Direction, the direction of the shadow gradients */
  direction: FlipDirection;
  /** Flipping progress in percent (0 - 100) */
  progress: number;
};

/**
 * Type describing the animation process
 * Only one animation process can be started at a same time
 */
type AnimationProcess = {
  /** List of frames in playback order. Each frame is a function. */
  frames: FrameAction[];
  /** Total animation duration */
  duration: number;
  /** Animation duration of one frame */
  durationFrame: number;
  /** Сallback at the end of the animation */
  onAnimateEnd: AnimationSuccessAction;
  /**
   * Animation start time on the render loop's frame clock, or `null` when no
   * frame has run yet in this loop generation.
   *
   * R5: it must never be a *stale* timestamp. `startAnimation` stamps it from
   * `this.timer`, which is the timestamp of the frame currently being rendered
   * — correct while the loop is running, and meaningless before its first tick
   * (loop not started yet, or restarted after a `stop()`). A stale or zero
   * stamp makes the first real rAF timestamp — `performance.now()`, which is
   * milliseconds-since-page-load and can be any number at all — overshoot the
   * whole frame list, so the turn plays instantly instead of animating.
   *
   * So the stamp is deferred rather than guessed: `start()`/`stop()` clear the
   * frame clock, `startedAt` inherits that `null`, and {@link Render.render}
   * binds it to the first frame the animation is actually drawn on. That is
   * the Phase 7 contract — "`startedAt` derives from the resumed frame clock,
   * never a stale `this.timer`" — and it degrades to today's behaviour exactly
   * when today's behaviour was already right (a running loop).
   */
  startedAt: number | null;
  /**
   * Index of the last frame that actually ran, or -1 before the first one.
   * It enforces one invariant — *every frame action runs at most once per
   * animation* — on both paths that can play the final frame: the render
   * loop's overshoot branch (a dropped rAF) and `finishAnimation()`'s forced
   * commit. Neither may replay a frame the other already played.
   */
  lastPlayedIndex: number;
};

/**
 * Book orientation
 */
export const Orientation = {
  PORTRAIT: 'portrait',
  LANDSCAPE: 'landscape',
} as const;
export type Orientation = (typeof Orientation)[keyof typeof Orientation];

/**
 * Which physical half of the book a turn folds — the *geometry* of a turn, as
 * opposed to the direction the book is heading in page order.
 *
 * They are the same thing under `ltr`. Under `rtl` they are opposites: turning
 * FORWARD (towards a higher page index) is performed by pulling the leaf on the
 * left, which is geometrically a BACK fold. Splitting them is what lets the fold
 * follow the finger while the turn still lands on the right page — the two
 * halves of CLAUDE.md's rule that `rtl` mirrors the turn direction and never the
 * pointer coordinates.
 *
 * Pure and total so the two callers that need it — {@link Render.setDirection}
 * for everything downstream of the renderer, and `Flip.start` for the
 * `FlipCalculation` it constructs — cannot drift apart.
 */
export function foldSide(direction: FlipDirection, rtl: boolean): FlipDirection {
  if (!rtl) return direction;

  return direction === FlipDirection.FORWARD ? FlipDirection.BACK : FlipDirection.FORWARD;
}

/** Stamp z-index only when the value changes (PLAN-3.1 B3.3). */
function setZIndexIfChanged(el: HTMLElement, value: string): void {
  if (el.style.zIndex !== value) el.style.zIndex = value;
}

/** ClassList remove that no-ops when the class is already absent (B3.4). */
function removeClass(el: HTMLElement, cls: string): void {
  if (el.classList.contains(cls)) el.classList.remove(cls);
}

/**
 * Class responsible for rendering the book.
 *
 * COLLAPSED from an abstract `Render` plus a single `HTMLRender` subclass. The
 * subclass held drawFrame/shadow DOM paint; the base already held the rAF loop,
 * layout, and orientation — and was itself DOM-bound (`offsetWidth`, Safari
 * sniff). That is not a renderer seam — it is one class split at an arbitrary
 * line. See `docs/ABSTRACTION-BOUNDARY.md`.
 */
export class Render {
  private readonly setting: FlipSetting;
  private readonly app: PageFlip;

  /** Parent HTML Element (the engine's `.stf__block`) */
  private readonly element: HTMLElement;

  private outerShadow!: HTMLElement;
  private innerShadow!: HTMLElement;
  private hardShadow!: HTMLElement;
  private hardInnerShadow!: HTMLElement;

  /** Left static book page */
  private leftPage: Page | null = null;
  /** Right static book page */
  private rightPage: Page | null = null;

  /** Page currently flipping */
  private flippingPage: Page | null = null;
  /** Next page at the time of flipping */
  private bottomPage: Page | null = null;

  /**
   * Pages that carried `--shown` (and copy-owners of temporary movers) after
   * the previous `drawFrame`. PLAN-3.1 B3.2: `clear()` is a delta against this
   * set rather than a walk of the live collection. Held as `Page` references
   * so a sweep still works after `PageFlip.clear()` destroys the collection
   * (that path empties the collection BEFORE `releasePages` → `cancelAnimation`).
   */
  private lastShown: Set<Page> = new Set();

  /**
   * The **geometric side** the current fold lives on, not the semantic turn
   * direction. Restamped by `setDirection` before every turn, which applies the
   * `direction: 'rtl'` mirror exactly once — see {@link foldSide}.
   *
   * Everything downstream of this field is geometry: local↔global conversion,
   * `PageOrientation` for the mover and the page under it, shadow gradient
   * sense, and the hard-page z-order in `drawFrame`. None of them care which
   * page index the book is heading for; all of them care which half of the book
   * the leaf is being pulled off.
   */
  private direction: FlipDirection = FlipDirection.FORWARD;
  /** Current book orientation */
  private orientation: Orientation | null = null;
  /** Сurrent state of the shadows */
  private shadow: Shadow | null = null;
  /** Сurrent animation process */
  private animation: AnimationProcess | null = null;
  /** Page borders while flipping */
  private pageRect: RectPoints | null = null;
  /** Current book area */
  private boundsRect: PageRect | null = null;

  /**
   * Timestamp of the frame currently being rendered, or `null` when no frame
   * has run yet in this loop generation. Cleared by `start()`/`stop()` — see
   * `AnimationProcess.startedAt` (R5).
   */
  private timer: number | null = null;

  /** Active requestAnimationFrame id; 0 when no frame is pending. */
  private rafId = 0;

  /**
   * True between `start()` and `stop()`.
   *
   * R8: `rafId !== 0` used to be the same question as "is this book alive?"
   * because the loop re-armed unconditionally. Now that it parks when there is
   * nothing to draw, the two questions are different — a parked loop has no
   * pending frame and is still perfectly alive — and only this field answers
   * the second one. It is what stops {@link requestFrame} resurrecting a loop
   * that was deliberately stopped (`destroy`, `attachMode` replacing a mode).
   */
  private running = false;

  /**
   * Something changed that the last drawn frame does not reflect.
   *
   * Cleared at the TOP of {@link render}, so anything a frame action, an
   * `onAnimateEnd` or a `drawFrame` mutates re-arms the loop for one more
   * frame. Every mutator on this class sets it through {@link requestFrame};
   * there is no other way for renderer state to change, which is what makes
   * "nothing to draw" a decidable question rather than a guess.
   */
  private dirty = true;

  /**
   * The scheduler closure of the current loop generation, or `null` when the
   * loop has never started or has been stopped.
   *
   * Kept so a parked loop can be resumed **without** going through `start()`:
   * `start()` calls `update()` (two forced layout reads) and bumps the
   * generation, and doing that on every pointer move — a parked loop is woken
   * by each one — would trade a rAF for a layout thrash.
   */
  private frameLoop: ((timer: number) => void) | null = null;

  /**
   * A frame has been requested and its callback has not run yet.
   *
   * The pending-ness of a frame, kept separately from {@link rafId} — see
   * {@link scheduleFrame} for why the id cannot answer that question.
   */
  private framePending = false;

  /**
   * Bumped by every `start()` and `stop()`. A scheduled `loop` callback only
   * runs if its captured generation is still current, so a frame queued by a
   * loop that has since been stopped (or superseded by a restart) is dropped.
   *
   * R7: this replaces comparing a captured rAF *id* against `this.rafId`. That
   * id was read by the closure before `let id = requestAnimationFrame(loop)`
   * had initialised it — a temporal dead zone the real rAF never enters
   * (it is never synchronous), but a synchronous fake, a polyfill, or a test
   * double does, and it threw `ReferenceError: Cannot access 'id' before
   * initialization`. A counter owned by the instance is initialised before the
   * closure exists, so the identity check has no ordering hazard at all.
   */
  private loopGeneration = 0;

  /**
   * Bumped by every `startAnimation` and every `cancelAnimation`.
   *
   * U5. `startAnimation` opens with `finishAnimation()`, and that callback is
   * `onAnimateEnd` — the thing that turns the page. A consumer chaining a turn
   * from `onFlip` (auto-advance, a controlled `page` prop, a queued gesture)
   * therefore re-enters `startAnimation` *from inside* the outer one, installs
   * its animation, and returns; the outer call then ran `this.animation = {...}`
   * unconditionally and replaced it. The chained animation's `onAnimateEnd`
   * never ran: a page turn that never commits.
   *
   * This is the OVERWRITE, not R4's NULL, and R4's fix does not reach it — R4
   * stopped a trailing `= null` from discarding a nested install, while here the
   * discard is the ordinary assignment at the bottom of the method.
   *
   * The nested animation wins, and the outer request is dropped rather than
   * merged, because by then the nested one owns the engine: `Flip.start` has
   * already replaced `calc`, the flipping page and `turnGeneration`. Letting the
   * outer animation install would drive the *new* calculation with the *old*
   * turn's frames, and its `onAnimateEnd` would commit a second page turn on top
   * of the one the callback just committed.
   *
   * A counter rather than "is `this.animation` still null?" because a nested
   * INSTANT turn (`flippingTime: 0`, reduced motion) installs nothing at all —
   * it runs its final frame and its callback synchronously — and that is exactly
   * where consumers auto-advance.
   */
  private animationGeneration = 0;

  /**
   * Safari browser definitions for resolving a bug with a css property clip-area
   *
   * https://bugs.webkit.org/show_bug.cgi?id=126207
   */
  private safari = false;

  /**
   * @param app - PageFlip object
   * @param setting - Configuration object
   * @param element - Parent HTML Element (the engine's `.stf__block`)
   */
  public constructor(app: PageFlip, setting: FlipSetting, element: HTMLElement) {
    this.setting = setting;
    this.app = app;
    this.element = element;

    // detect safari — never touch window at module scope; guard for Node/SSR
    this.safari = isSafariUserAgent();

    this.createShadows();
  }

  private createShadows(): void {
    this.element.insertAdjacentHTML(
      'beforeend',
      '<div class="stf__outerShadow"></div><div class="stf__innerShadow"></div>' +
        '<div class="stf__hardShadow"></div><div class="stf__hardInnerShadow"></div>',
    );

    const outer = this.element.querySelector<HTMLElement>('.stf__outerShadow');
    const inner = this.element.querySelector<HTMLElement>('.stf__innerShadow');
    const hard = this.element.querySelector<HTMLElement>('.stf__hardShadow');
    const hardInner = this.element.querySelector<HTMLElement>('.stf__hardInnerShadow');

    if (!outer || !inner || !hard || !hardInner) {
      throw new PageFlipError('Shadow setup failed', 'RENDER_SETUP');
    }

    this.outerShadow = outer;
    this.innerShadow = inner;
    this.hardShadow = hard;
    this.hardInnerShadow = hardInner;
  }

  /**
   * Reload the render area, after update pages
   */
  public reload(): void {
    // B3.2: drop stale `--shown` / orphaned clones from the previous collection
    // generation before the new leaves draw. Sweep the retained set — never the
    // live collection (which may already be empty or replaced).
    this.sweepShownSet();

    // B3.1: new or replaced leaves must not inherit a stale style memo from a
    // prior collection generation (same DOM node reused after updateFromHtml).
    this.bustPageDrawCaches();

    const testShadow = this.element.querySelector('.stf__outerShadow');

    if (!testShadow) {
      this.createShadows();
    }
  }

  /**
   * Bust every leaf's applyEngineStyle memo when a collection is attached.
   * No-op for render-loop harnesses that stub `app` without GET_COLLECTION.
   */
  private bustPageDrawCaches(): void {
    const getCollection = this.app[GET_COLLECTION];
    if (typeof getCollection !== 'function') return;
    try {
      getCollection.call(this.app).invalidateDrawCache();
    } catch {
      // NOT_LOADED — nothing to bust.
    }
  }

  /**
   * Executed when requestAnimationFrame is called. Performs the current animation process and call drawFrame()
   *
   * @param timer
   */
  private render(timer: number, generation = this.loopGeneration): void {
    // R8: this frame is about to draw everything asked for so far, so the
    // request is consumed HERE — before the frame actions, the callback and
    // `drawFrame` run. Anything any of them changes sets the flag again and
    // buys one more frame; clearing it afterwards instead would swallow
    // whatever `drawFrame` itself observed as changed.
    this.dirty = false;

    // R2: stamp the frame clock BEFORE running any frame action or callback.
    // `startAnimation` reads `this.timer` for `startedAt`, so an animation
    // started from inside a frame action — or from an `onAnimateEnd` that
    // chains another turn (auto-advance, a queued turn, a consumer calling
    // `flipNext()` from `onFlip`) — would otherwise be stamped with the
    // PREVIOUS frame's timestamp and begin one whole frame in the past. With a
    // short `flippingTime` that is enough for the very next tick to overshoot
    // the frame list, so the chained turn plays only its final frame.
    this.timer = timer;

    if (this.animation !== null) {
      // R5: an animation started before the loop's first tick has no stamp yet
      // (`startedAt === null`); it binds here, to the first frame it is
      // actually drawn on, so it plays from frame 0 instead of arriving
      // pre-expired. An animation stamped while the loop was running keeps its
      // stamp — `??=` only fills a hole.
      const startedAt = (this.animation.startedAt ??= timer);

      // Find current frame of animation
      const frameIndex = Math.round((timer - startedAt) / this.animation.durationFrame);

      const lastIndex = this.animation.frames.length - 1;

      if (frameIndex < this.animation.frames.length) {
        // AT MOST ONCE, which is what `lastPlayedIndex` is documented to
        // guarantee and only half-delivered: the guard existed on the overshoot
        // and forced-commit paths and not on the ordinary one, so several ticks
        // landing on the same index replayed it. Measured: two frames over
        // 1000 ms ticked at 0 ms and 100 ms produced `[0, 0]`.
        //
        // Harmless in output — a frame action is "the fold is at point P", so
        // replaying it recomputes the same geometry — but not free: each replay
        // re-ran `Flip.do` and, through the setters it calls, re-dirtied the
        // renderer and forced another `drawFrame()` of identical pixels. Under
        // the parked loop (C1) that is the difference between a short animation
        // costing one draw per frame and one draw per tick.
        if (this.animation.lastPlayedIndex !== frameIndex) {
          this.animation.lastPlayedIndex = frameIndex;
          at(this.animation.frames, frameIndex)();
        }
      } else {
        // The clock overshot the end of the list — under load rAF skips
        // frames, and the last one carries the turn's final geometry. Play it
        // before committing, exactly as `finishAnimation()` does; the
        // `lastPlayedIndex` guard keeps it from running twice when the loop
        // already landed on it on the previous tick.
        const animation = this.animation;
        this.animation = null;

        if (animation.lastPlayedIndex !== lastIndex) {
          animation.lastPlayedIndex = lastIndex;
          at(animation.frames, lastIndex)();
        }

        animation.onAnimateEnd();
      }
    }

    // U6 / the X4 follow-up. `onAnimateEnd` emitted `flip` synchronously above,
    // and a consumer may have torn the book down from that handler — the
    // documented, supported way to clean up when a turn completes. Drawing
    // afterwards paints into a released collection and a detached canvas.
    //
    // `stop()` bumps the generation, so this is the same signal the loop guard
    // uses; checking it here removes the trailing frame instead of trying to
    // make it survivable.
    if (generation !== this.loopGeneration) return;

    this.drawFrame();
  }

  /**
   * Running requestAnimationFrame, and rendering process
   */
  public start(): void {
    // R3: `stop()` guards `cancelAnimationFrame`; this guards its counterpart.
    // The asymmetry is deliberate, not symmetric-by-copy: teardown must never
    // throw (a loop you cannot cancel in an environment without the API was
    // never running), but a loop that cannot START is a fatal misconfiguration
    // — every subsequent frame, turn and commit silently never happens. A
    // book that quietly renders nothing is exactly the failure mode this repo
    // keeps paying for, so it is a typed `PageFlipError` like every other
    // boundary failure here, not a raw `ReferenceError` and not a shrug.
    //
    // This is a call-time guard, not a module-scope one, so the SSR import
    // rule is unaffected: importing the engine on a server stays legal, and
    // only actually driving a render loop there fails.
    if (typeof requestAnimationFrame !== 'function') {
      throw new PageFlipError(
        'requestAnimationFrame is not available in this environment',
        'NO_ANIMATION_FRAME',
      );
    }

    // RE-1. `update()` DISPATCHES, and this method is halfway through.
    //
    // On a fresh render `this.orientation` is null, so the first `update()`
    // always reports an orientation change — and `PageFlip.updateOrientation`
    // runs `pages.show()` (emitting `flip`) before it emits `changeOrientation`.
    // So consumer code runs here, on the LOAD path, with the loop not yet
    // installed, and this method used to go on and set `running`, install
    // `frameLoop` and schedule a frame unconditionally.
    //
    // Two measured outcomes, both from a listener on that first `flip`:
    //
    //  - `destroy()` — teardown ran `stop()`, then this method re-armed. One
    //    frame ran AFTER the destroy and threw `DESTROYED` out of
    //    `clear()`. That is X4 exactly, on the load path instead of
    //    the turn path, and X4's own guard cannot help: the generation is
    //    bumped below, i.e. AFTER the destroy, so the zombie loop's generation
    //    is legitimately current.
    //  - `loadFromHTML()` — the nested `attachMode` installs a new UI, render
    //    and collection, and then this method revives the OLD, detached render.
    //    Its `clear()` iterates `app[GET_COLLECTION]()` — the NEW collection —
    //    and hides every page that is not one of the old render's references.
    //    Measured: all six pages of the freshly loaded book ended
    //    `display: none`, both loops parked, and nothing scheduled another
    //    frame. A permanently blank book until a resize or a turn.
    //
    // The generation is the right instrument and it already exists: `stop()`
    // bumps it, and both `destroy()` and `attachMode` call `stop()`. Capture it
    // across the dispatch and install nothing if it moved — whoever moved it
    // owns the renderer now.
    const entryGeneration = this.loopGeneration;

    this.update();

    // BEFORE `stop()`, and the order is the whole guard. `stop()` bumps
    // `loopGeneration` itself, so a check placed after it compares the
    // generation against one this method just moved — always unequal, always
    // returning early, and the loop never starts at all. That variant is not
    // hypothetical: it is what this fix was accidentally reformatted into, and
    // the only thing that caught it was an unrelated U6 test noticing that no
    // animation ever ran.
    if (entryGeneration !== this.loopGeneration) return;

    this.stop();

    // R7: capture the generation, not the rAF id. `generation` is fully
    // initialised before `loop` is even created, so a synchronous rAF (a fake,
    // a polyfill, a test double) cannot observe it in its temporal dead zone.
    const generation = ++this.loopGeneration;

    const loop = (timer: number): void => {
      if (generation !== this.loopGeneration) return;

      // Cleared INSIDE the generation guard: a callback left over from a
      // superseded loop must not report the CURRENT loop's pending frame as
      // consumed, or the next `requestFrame()` would schedule a second live
      // loop alongside it.
      this.framePending = false;

      this.render(timer, generation);

      // Re-check AFTER the frame. `onAnimateEnd` fires a `flip` event
      // synchronously from inside `render()`, and a consumer is entitled to
      // call `destroy()` from it — which calls `stop()` and bumps the
      // generation. Re-arming regardless scheduled one more frame and kept this
      // closure (and the engine it captures) alive until it fired.
      if (generation !== this.loopGeneration) return;

      // R8: the park decision is taken AFTER `render()`, and that ordering is
      // the whole safety argument. `render()` runs the animation's frame action
      // and then `drawFrame()`, so the frame that ends a turn has already
      // painted that turn's final geometry by the time we get here. Deciding
      // before the draw — "no animation left, so stop" — is the one-frame-early
      // bug: the leaf commits a turn whose last pose was never painted.
      if (this.isIdle()) {
        this.park();
        return;
      }

      this.scheduleFrame();
    };

    this.running = true;
    this.dirty = true;
    this.frameLoop = loop;

    this.scheduleFrame();
  }

  /**
   * Arm one animation frame, unless one is already armed or the loop is
   * stopped.
   *
   * R8: "is a frame already armed?" is {@link framePending}, NOT `rafId !== 0`.
   * Under a SYNCHRONOUS `requestAnimationFrame` — a polyfill, a test double,
   * `jest`'s timer shim — the callback runs before `requestAnimationFrame`
   * returns, so the assignment of its id lands *after* the frame it identifies
   * has already finished and parked. `rafId` is then a non-zero id for a frame
   * that will never fire, and a loop keyed on it would refuse to schedule
   * anything ever again: the book stops drawing and never restarts, which is a
   * far worse defect than the idling this whole change removes. The flag is set
   * BEFORE the call and cleared by the callback, so the ordering cannot lie.
   */
  private scheduleFrame(): void {
    const loop = this.frameLoop;

    if (this.framePending || !this.running || loop === null) return;

    this.framePending = true;
    this.rafId = requestAnimationFrame(loop);
  }

  /**
   * Is there nothing left to draw?
   *
   * Three ways to answer "no", and all three are load-bearing:
   *
   *  - **an animation is in flight** — every frame moves the leaf;
   *  - **{@link dirty}** — some renderer state changed since the last frame.
   *    Every mutator here routes through {@link requestFrame}, so this covers a
   *    turn, a drag, a corner hover, a resize, an orientation change, a
   *    collection swap and `update()` without any of them knowing about the
   *    scheduler;
   *  - **{@link needsContinuousFrames}** — the renderer paints something that
   *    moves on its own clock, with no state change to observe.
   */
  private isIdle(): boolean {
    return this.animation === null && !this.dirty && !this.needsContinuousFrames();
  }

  /**
   * Does this renderer paint something that changes without anyone telling it?
   *
   * HTML mode has nothing of the kind — an idle book parks. Canvas mode used
   * to force continuous frames for its loader spinner; that path is gone
   * (ADR 0002).
   */
  private needsContinuousFrames(): boolean {
    return false;
  }

  /**
   * Suspend the loop with nothing to draw. NOT `stop()`: the loop is still
   * *running* in the sense that matters — {@link requestFrame} may resume it —
   * and the generation deliberately does not move, so the closure `start()`
   * built stays valid and is reused on the next wake.
   */
  private park(): void {
    this.rafId = 0;

    // R5: the frame clock belongs to a RUN of frames, not to the object. A
    // parked loop may sit for minutes; an animation installed in that window
    // must not be stamped with the timestamp of the last frame before the park,
    // or it arrives already expired and plays only its final frame. `null`
    // sends it down the lazy-binding path, which stamps it on the frame it is
    // first drawn on — the same contract `stop()` relies on.
    this.timer = null;
  }

  /**
   * Ask for one more frame, resuming the loop if it has parked.
   *
   * Called by every mutator on this class, so a caller changing renderer state
   * never has to know the loop can park. Cheap and idempotent: with a frame
   * already pending it only sets a flag.
   *
   * `protected`, not public: adding to the published surface is a product
   * decision, and nothing outside the renderer needs it — every engine-side
   * mutation already goes through a method here, and a consumer that wants a
   * repaint has `PageFlip.update()`. A subclass (canvas, on image decode) is
   * the one caller that could plausibly need it, and it has it.
   */
  protected requestFrame(): void {
    this.dirty = true;

    this.scheduleFrame();
  }

  /** Cancel the render loop. Safe to call more than once. */
  public stop(): void {
    if (this.rafId !== 0 && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = 0;

    // R8: a stopped loop must stay stopped. `requestFrame` resumes a PARKED
    // loop, and the only thing separating the two states is this flag — and
    // dropping the closure, so nothing can be scheduled against a torn-down
    // engine even if a late mutator asks.
    this.running = false;
    this.frameLoop = null;
    this.framePending = false;

    // Invalidate any frame already queued: `cancelAnimationFrame` may be
    // missing (R3) and, more importantly, a callback can already be in flight.
    this.loopGeneration += 1;

    // R5: the frame clock belongs to a loop generation, not to the object. A
    // turn started while the loop is parked must not inherit the timestamp of
    // whatever frame happened to run last — see `AnimationProcess.startedAt`.
    this.timer = null;
  }

  /**
   * Start a new animation process
   *
   * @param {FrameAction[]} frames - Frame list
   * @param {number} duration - total animation duration
   * @param {AnimationSuccessAction} onAnimateEnd - Animation callback function
   */
  public startAnimation(
    frames: FrameAction[],
    duration: number,
    onAnimateEnd: AnimationSuccessAction,
  ): void {
    // R8: a turn is the loudest possible "wake up". Redundant TODAY — the
    // `finishAnimation()` below wakes the loop on every path through this
    // method, including the early returns — and kept anyway, stated as
    // redundant rather than dressed up as load-bearing: the alternative is that
    // "starting an animation schedules frames" holds only because of the order
    // of two unrelated lines, and the failure if that order ever changes is a
    // turn that animates nothing.
    this.requestFrame();

    // U5: claim this call's slot BEFORE the commit below can re-enter us. If
    // `finishAnimation()`'s callback starts another animation, that nested call
    // bumps the counter and everything below this line belongs to a superseded
    // request — see {@link Render.animationGeneration}.
    const generation = ++this.animationGeneration;

    this.finishAnimation(); // finish the previous animation process

    if (generation !== this.animationGeneration) return;

    if (duration <= 0 || frames.length === 0) {
      if (frames.length > 0) {
        at(frames, frames.length - 1)();
      }
      onAnimateEnd();

      // R4 (same defect, second site): there used to be a `this.animation =
      // null` here. It was redundant on the ordinary path — `finishAnimation()`
      // above already nulled it and the instant path never sets one — and
      // actively wrong on the interesting one: if `onAnimateEnd` chains a turn
      // (auto-advance, a queued flip, a consumer calling `flipNext()` from
      // `onFlip`), that nested `startAnimation` installs the new animation and
      // this line threw it away, leaving the book with no animation and no
      // pending commit. Instant turns are the *most* likely to chain, since
      // `flippingTime: 0` and `prefers-reduced-motion` are exactly where
      // consumers auto-advance.
      return;
    }

    this.animation = {
      frames,
      duration,
      durationFrame: duration / frames.length,
      onAnimateEnd,
      startedAt: this.timer,
      lastPlayedIndex: -1,
    };
  }

  /**
   * End the current animation process and call the callback
   */
  public finishAnimation(): void {
    // R8: a forced commit runs a frame action and `onAnimateEnd` outside the
    // loop, so whatever they change needs painting. Asked for unconditionally
    // rather than only when there was an animation: `Flip` calls this from
    // pointer handling, where the state around it has just moved anyway, and
    // one redundant frame on a no-op is cheaper than reasoning about which
    // callers can skip it.
    this.requestFrame();

    // R4: detach BEFORE running the callback, exactly as the render loop's
    // overshoot branch does. `onAnimateEnd` is what turns the page, and a
    // consumer that chains a turn from it (`onFlip` → `flipNext()`,
    // auto-advance, a queued gesture) reaches `startAnimation`, which installs
    // the next animation on this same object. A trailing `this.animation =
    // null` after the callback then discarded that fresh animation: no frames
    // scheduled, no commit pending, the book frozen mid-turn until the next
    // pointer event. Read the field once, clear it, then run the callback —
    // anything the callback installs is nobody else's to clean up.
    const animation = this.animation;
    this.animation = null;

    if (animation !== null) {
      // R1: the same "exactly once" rule the render loop's overshoot branch
      // obeys. `lastPlayedIndex` is one invariant — *every frame action runs at
      // most once per animation* — so it cannot have two implementations.
      //
      // The rejected alternative was to call this an "external forced commit"
      // whose job is to re-assert final geometry. It does not survive contact
      // with the two call sites (Flip.ts:65, Flip.ts:314): both fire from
      // pointer handling with no geometry change in between, so re-running the
      // last frame re-asserts something that was asserted microseconds ago and
      // buys nothing. The risk is asymmetric — a redundant idempotent
      // `this.do(p)` is worth zero, while a frame action that ever acquires a
      // side effect runs twice — so the guard is the cheap side of the trade.
      const lastIndex = animation.frames.length - 1;

      if (animation.lastPlayedIndex !== lastIndex) {
        animation.lastPlayedIndex = lastIndex;
        at(animation.frames, lastIndex)();
      }

      animation.onAnimateEnd();
    }
  }

  /**
   * Recalculate the size of the displayed area, and update the page orientation
   */
  public update(): void {
    // R8, and this is the wake-up path with the most entrances: the
    // `ResizeObserver` and `visualViewport` handlers in `UI`, an orientation
    // change (`PageFlip.updateOrientation` → `UI.setOrientationStyle`),
    // `PageFlip.update()`, and `updateSettings`. Asked for before the
    // unobserved early return, because a book that has just been un-hidden
    // reaches that return on the pass that measured zero and the real box
    // arrives on the next one.
    this.requestFrame();

    // B3.1: geometry / settings / orientation all funnel through here. Bust
    // every leaf's applyEngineStyle memo so the next draw rewrites width/left
    // / --stf-paper rather than skipping on a stale cache key.
    this.bustPageDrawCaches();

    const { rect, orientation, observed } = this.computeBounds();

    // C5: a container with no box is not an observation of a portrait book —
    // it is the absence of an observation (`display: none`, a collapsed tab, a
    // detached node). At width 0 the portrait test (`0 < minWidth * 2`) is
    // trivially true, which is how hiding a book emitted a bogus
    // `changeOrientation` and showing it again emitted the opposite one. Keep
    // the last measured bounds and orientation and stay quiet; the
    // ResizeObserver fires again with a real box when the element becomes
    // visible, and that pass emits only if the orientation really changed.
    //
    // The exception is a book that has never been measured at all: there is no
    // previous observation to retain, and refusing to have an orientation is
    // its own defect (it would leave the book landscape-by-default and rebuild
    // the collection on first paint). So the first pass still establishes one,
    // and only subsequent zero measurements are ignored.
    //
    // Collapse note: under the old inheritance, `super.update()`'s early return
    // still let the subclass run the left/right `setOrientation` stamps below.
    // Bounds/orientation adopt are gated; the stamps always run.
    if (observed || this.orientation === null) {
      const previous = this.boundsRect;
      const boundsChanged =
        observed &&
        previous !== null &&
        (previous.left !== rect.left ||
          previous.top !== rect.top ||
          previous.width !== rect.width ||
          previous.height !== rect.height ||
          previous.pageWidth !== rect.pageWidth);

      // Cancel a live curl before the new box is stamped. FlipCalculation is
      // frozen at turn start; adopting new bounds while it is live splits the
      // static spread from the fold. At rest this is a no-op (no calc).
      if (boundsChanged) {
        this.app[INVALIDATE_FOLD_GEOMETRY]();
      }

      this.boundsRect = rect;

      if (this.orientation !== orientation) {
        this.orientation = orientation;
        this.app[ADOPT_ORIENTATION](orientation);
      }
    }

    if (this.rightPage !== null) {
      this.rightPage.setOrientation(PageOrientation.RIGHT);
    }

    if (this.leftPage !== null) {
      this.leftPage.setOrientation(PageOrientation.LEFT);
    }
  }

  /**
   * Calculate the size and position of the book depending on the parent element and configuration parameters
   *
   * `observed` is false when the container has no measurable box; the rect is
   * still computed (it collapses to the container's zeros) so that geometry
   * callers keep working on a book nobody can see, but callers must not treat
   * it — or the orientation that falls out of it — as a measurement. See
   * {@link update}.
   */
  private computeBounds(): { rect: PageRect; orientation: Orientation; observed: boolean } {
    let orientation: Orientation = Orientation.LANDSCAPE;

    const blockWidth = this.getBlockWidth();
    const blockHeight = this.getBlockHeight();
    const observed = blockWidth > 0 && blockHeight > 0;

    const middlePoint: Point = {
      x: blockWidth / 2,
      y: blockHeight / 2,
    };

    const ratio = this.setting.width / this.setting.height;

    let pageWidth = this.setting.width;
    let pageHeight = this.setting.height;

    let left = middlePoint.x - pageWidth;

    // W2. `this.setting` throughout, not `this.app.getSettings()`.
    //
    // The two are the same object today — `PageFlip` hands its own settings
    // reference to the constructor and `updateSettings` mutates it in place —
    // so this is provably inert, and it is recorded as a consistency fix rather
    // than dressed up as a defect. What it removes is the Y5 bug class: two
    // ways to reach one value, latent until somebody clones the settings on the
    // way in and only ONE of the two readers keeps seeing updates. The test
    // beside it pins the invariant that makes both correct.
    if (this.setting.sizing === SizeMode.RESPONSIVE) {
      if (blockWidth < this.setting.minWidth * 2 && this.setting.usePortrait)
        orientation = Orientation.PORTRAIT;

      pageWidth = orientation === Orientation.PORTRAIT ? blockWidth : blockWidth / 2;

      if (pageWidth > this.setting.maxWidth) pageWidth = this.setting.maxWidth;

      pageHeight = pageWidth / ratio;

      // `maxHeight` was validated, defaulted, returned by `getSettings()` and
      // never read — so a responsive book could not be height-capped, while
      // `maxWidth` above worked. The asymmetry was the tell: someone declared
      // the setting because the need is real (a book in a short viewport, or
      // beside other content), and deleting the key would have removed an
      // advertised feature rather than implementing it. Owner decision.
      //
      // Clamped BEFORE the block-height fit, so an explicit cap and the
      // available space compose: whichever is tighter wins, and the aspect
      // ratio is preserved either way by re-deriving width from height.
      const heightCap = Math.min(this.setting.maxHeight, blockHeight);

      if (pageHeight > heightCap) {
        pageHeight = heightCap;
        pageWidth = pageHeight * ratio;
      }

      left =
        orientation === Orientation.PORTRAIT
          ? middlePoint.x - pageWidth / 2 - pageWidth
          : middlePoint.x - pageWidth;
    } else {
      if (blockWidth < pageWidth * 2 && this.setting.usePortrait) {
        orientation = Orientation.PORTRAIT;
        left = middlePoint.x - pageWidth / 2 - pageWidth;
      }
    }

    return {
      rect: {
        left,
        top: middlePoint.y - pageHeight / 2,
        width: pageWidth * 2,
        height: pageHeight,
        pageWidth,
      },
      orientation,
      observed,
    };
  }

  /**
   * Set the current parameters of the drop shadow
   *
   * @param {Point} pos - Shadow Position Start Point
   * @param {number} angle - The angle of the shadows relative to the book
   * @param {number} progress - Flipping progress in percent (0 - 100)
   * @param {FlipDirection} direction - Flipping Direction, the direction of the shadow gradients
   */
  public setShadowData(
    pos: Point,
    angle: number,
    progress: number,
    direction: FlipDirection,
  ): void {
    if (!this.app.getSettings().drawShadow) {
      // X3: turning `drawShadow` off mid-fold has to take the shadow that is
      // already on screen with it. `drawFrame` draws whatever `this.shadow`
      // holds, so a bare `return` here froze the last computed shadow over the
      // moving leaf until the turn ended and `clearShadow()` ran. The setting is
      // read here, so the state it guards is cleared here.
      //
      // `clearShadow()`, not `this.shadow = null`: `clearShadow` also hides the
      // four shadow ELEMENTS, and nothing else in `drawFrame` ever resets them
      // — dropping the field alone would stop the shadow being recomputed while
      // leaving the last one painted, which is the reported defect with an
      // extra step.
      this.clearShadow();
      return;
    }

    const maxShadowOpacity = 100 * this.getSettings().maxShadowOpacity;

    // R8: a drag and a corner hover reach the renderer through here and the
    // four page setters below, once per pointer move. That is what wakes a
    // parked loop for a gesture.
    this.requestFrame();

    this.shadow = {
      pos,
      angle,
      width: (((this.getRect().pageWidth * 3) / 4) * progress) / 100,
      opacity: ((100 - progress) * maxShadowOpacity) / 100 / 100,
      direction,
      progress: progress * 2,
    };
  }

  /**
   * Clear shadow
   */
  public clearShadow(): void {
    // Order is load-bearing: requestFrame first (wake the parked loop), then
    // drop the field, then hide the four DOM nodes. `drawFrame` only *writes*
    // shadows from a non-null `this.shadow`; without the cssText hide the last
    // painted shadow would stay on screen (X3 / RD1).
    this.requestFrame();

    this.shadow = null;

    this.outerShadow.style.cssText = 'display: none';
    this.innerShadow.style.cssText = 'display: none';
    this.hardShadow.style.cssText = 'display: none';
    this.hardInnerShadow.style.cssText = 'display: none';
  }

  /**
   * Abandon the running animation WITHOUT committing it.
   *
   * `finishAnimation()` is a commit: it runs the final frame and invokes
   * `onAnimateEnd`, which turns the page. When the collection underneath is
   * being replaced, that callback belongs to pages that no longer exist, so the
   * turn must be dropped rather than finished.
   */
  /**
   * Is an animation currently in flight?
   *
   * `Flip` needs this to tell a machine-driven fold — a corner peel-in, a
   * snap-back, a turn — from one the reader is dragging, because a drag never
   * animates. See V1 in {@link Flip.fold}. Deliberately not `getAnimation()`:
   * the process object is the renderer's, and handing it out invites a caller
   * to reach into `frames` or `startedAt`.
   */
  public isAnimating(): boolean {
    return this.animation !== null;
  }

  public cancelAnimation(): void {
    // R8: abandoning a turn drops the fold, so the spread underneath has to be
    // repainted without it — `UI.cancelGesture` and `PageFlip.replacePages`
    // both rely on that repaint happening.
    this.requestFrame();

    // U5, the same slot: abandoning a turn from inside an `onAnimateEnd` —
    // `replacePages` / `destroy` called from an `onFlip` handler — must not
    // leave the outer `startAnimation` free to install an animation over pages
    // that have just been released.
    this.animationGeneration += 1;

    this.animation = null;

    // RD1: `clearShadow()`, not `this.shadow = null` — the X3 defect at a second
    // site. `clearShadow` hides the four shadow ELEMENTS as well, and nothing
    // in `drawFrame` ever resets them: it only *writes* them, from a non-null
    // `this.shadow`. Dropping the field alone therefore stops the shadow being
    // recomputed while leaving the last one painted — so abandoning a turn
    // because the collection is being replaced (React's `updateFromHtml`,
    // `replacePages`) left a stale fold shadow lying over the new book until
    // some later turn happened to end.
    this.clearShadow();

    // B3.2: sweep BEFORE nulling the mover slots so a clone that never entered
    // `lastShown` (cancelled before its first frame) is still cleaned. The
    // sweep never asks the live collection — required because `PageFlip.clear()`
    // destroys the collection before `releasePages` → here.
    this.sweepShownSet();

    this.flippingPage = null;
    this.bottomPage = null;

    // RD2: the fold rect belongs to the turn, not to the renderer. It is the
    // clip `drawInnerShadow` cuts the inner shadow against, so a rect left over
    // from a collection that no longer exists can clip the first frame of the
    // NEXT fold. Every other piece of per-turn state is dropped here; this one
    // was simply missed.
    this.pageRect = null;
  }

  /**
   * Drop every page reference the renderer holds.
   *
   * Emptying the collection is not enough to release pages — and for canvas a
   * page owns a decoded image — because the renderer keeps its own left/right/
   * flipping/bottom references.
   */
  public releasePages(): void {
    this.cancelAnimation();
    this.leftPage = null;
    this.rightPage = null;
  }

  /**
   * Get parent block offset width
   */
  public getBlockWidth(): number {
    return this.app[GET_UI]().getDistElement().offsetWidth;
  }

  /**
   * Get parent block offset height
   */
  public getBlockHeight(): number {
    return this.app[GET_UI]().getDistElement().offsetHeight;
  }

  /**
   * The geometric side of the current fold — see {@link Render.direction}.
   *
   * Under `direction: 'ltr'` this is identical to the direction the turn was
   * started with. Under `'rtl'` it is its mirror, because the mirrored *turn*
   * is performed by folding the *other* half of the book.
   */
  public getDirection(): FlipDirection {
    return this.direction;
  }

  /**
   * Сurrent size and position of the book
   */
  public getRect(): PageRect {
    // C11: the `RENDER_NOT_READY` throw that used to live here was dead code —
    // `calculateBoundsRect` always assigned `boundsRect`, so the branch could
    // not fire, and an unreachable error is a lie in the published surface.
    //
    // It is deleted rather than made reachable. The candidate for making it
    // real was the unmeasured-container case (C5), but bounds are always
    // derivable — the settings carry width/height and the container carries
    // whatever box it has, including none. Turning "you cannot see this book
    // yet" into a thrown error would mean a book mounted inside `display: none`
    // crashes the rAF loop and every programmatic turn, which is a worse defect
    // than the one being fixed. So geometry is always answerable; what a
    // zero-size container is not allowed to do is *claim an orientation*, and
    // that is where C5's fix lives (see `update`).
    const bounds = this.boundsRect ?? this.computeBounds().rect;

    this.boundsRect = bounds;

    return bounds;
  }

  /**
   * Get configuration object
   */
  public getSettings(): FlipSetting {
    return this.app.getSettings();
  }

  /**
   * Get current book orientation
   */
  public getOrientation(): Orientation {
    // `null` only before the first `update()`; the book is landscape until
    // `calculateBoundsRect` proves otherwise.
    return this.orientation ?? Orientation.LANDSCAPE;
  }

  /**
   * Set page area while flipping
   *
   * @param direction
   */
  public setPageRect(pageRect: RectPoints): void {
    this.requestFrame();

    this.pageRect = pageRect;
  }

  /**
   * Announce the **semantic** direction of the turn that is starting; the
   * renderer stores the geometric side that turn folds on.
   *
   * The mirror lives here, and only here, on purpose. `direction: 'rtl'`
   * mirrors the turn direction (`Flip.getDirectionByPoint`, `UI.swipeDirection`)
   * — but every geometric consumer of {@link Render.direction} then read that
   * already-mirrored value and mirrored the *coordinates* with it, which is the
   * thing CLAUDE.md forbids: `convertToPage` derives local x from the direction,
   * so an RTL drag was measured against the half of the book the finger was not
   * on. A 30 px drag reported 92.5% progress instead of 7.5% and committed a
   * turn on release.
   *
   * Deriving the side inside the setter, rather than at the call site, is what
   * makes that unrepeatable: a future caller cannot forget the mirror, because
   * there is no un-mirrored way to reach the field.
   *
   * @param direction - where the book is heading in page order
   */
  public setDirection(direction: FlipDirection): void {
    this.requestFrame();

    this.direction = foldSide(direction, this.getSettings().readingDirection === 'rtl');
  }

  /**
   * Set right static book page
   *
   * @param page
   */
  public setRightPage(page: Page | null): void {
    // R8: `PageCollection.showSpread` always sets both static leaves, so this
    // and `setLeftPage` are the wake-up for every collection change there is —
    // a committed turn, `replacePages`, `updateFromHtml`, `clear`, the initial
    // `show()`, and `UI.cancelGesture`'s repaint.
    this.requestFrame();

    if (page !== null) page.setOrientation(PageOrientation.RIGHT);

    this.rightPage = page;
  }

  /**
   * Set left static book page
   * @param page
   */
  public setLeftPage(page: Page | null): void {
    this.requestFrame();

    if (page !== null) page.setOrientation(PageOrientation.LEFT);

    this.leftPage = page;
  }

  /**
   * Set next page at the time of flipping
   * @param page
   */
  public setBottomPage(page: Page | null): void {
    this.requestFrame();

    if (page !== null)
      page.setOrientation(
        this.direction === FlipDirection.BACK ? PageOrientation.LEFT : PageOrientation.RIGHT,
      );

    this.bottomPage = page;
  }

  /**
   * Set currently flipping page
   *
   * @param page
   */
  public setFlippingPage(page: Page | null): void {
    this.requestFrame();

    if (page !== null)
      page.setOrientation(
        this.direction === FlipDirection.FORWARD && this.orientation !== Orientation.PORTRAIT
          ? PageOrientation.LEFT
          : PageOrientation.RIGHT,
      );

    this.flippingPage = page;
  }

  /**
   * Coordinate conversion function. Window coordinates -> to book coordinates
   *
   * @param {Point} pos - Global coordinates relative to the window
   * @returns {Point} Coordinates relative to the book
   */
  public convertToBook(pos: Point): Point {
    const rect = this.getRect();

    return {
      x: pos.x - rect.left,
      y: pos.y - rect.top,
    };
  }

  public isSafari(): boolean {
    return this.safari;
  }

  /**
   * Coordinate conversion function. Window coordinates -> to current coordinates of the working page
   *
   * @param {Point} pos - Global coordinates relative to the window
   * @param {FlipDirection} direction  - Current flipping direction
   *
   * @returns {Point} Coordinates relative to the work page
   */
  public convertToPage(pos: Point, direction?: FlipDirection | null): Point {
    direction ??= this.direction;

    const rect = this.getFoldRect(direction);
    const x =
      direction === FlipDirection.FORWARD
        ? pos.x - rect.left - rect.width / 2
        : rect.width / 2 - pos.x + rect.left;

    return {
      x,
      y: pos.y - rect.top,
    };
  }

  /**
   * Coordinate conversion function. Coordinates relative to the work page -> Window coordinates
   *
   * @param {Point} pos - Coordinates relative to the work page
   * @param {FlipDirection} direction  - Current flipping direction
   *
   * @returns {Point} Global coordinates relative to the window
   */
  public convertToGlobal(pos: Point | null, direction?: FlipDirection | null): Point | null {
    if (pos == null) return null;

    return this.convertPointToGlobal(pos, direction ?? this.direction);
  }

  /**
   * Non-nullable variant of {@link convertToGlobal} for callers that already
   * hold a point.
   */
  public convertPointToGlobal(pos: Point, direction?: FlipDirection): Point {
    direction ??= this.direction;

    return convertPageToGlobal(pos, direction, this.getFoldRect(direction));
  }

  /**
   * X1. The bounds rect **re-anchored to the leaf this fold is actually
   * pulling** — the frame every local↔global conversion is expressed in.
   *
   * The fold-local frame has its origin on the folded leaf's *spine* and runs
   * `+x` towards that leaf's free edge, so the leaf occupies `[0, pageWidth]`
   * and `FlipCalculation` can be direction-agnostic: `x = pageWidth` is
   * untouched, `x = 0` is folded flat onto the spine, `x = -pageWidth` is
   * turned. A BACK fold reads as a rightward on-screen curl purely because its
   * frame is mirrored — its `+x` points left.
   *
   * Both conversions (`convertToPage` here, `convertPageToGlobal` in
   * `geometry.ts`) put that origin at `left + width / 2`, which is right for
   * three of the four cases and was wrong for the fourth:
   *
   * - **Landscape.** Both leaves meet at the middle of the bounds rect, so the
   *   FORWARD leaf's left edge and the BACK leaf's right edge are the same
   *   line. One axis serves both. Unchanged by this fix.
   * - **Portrait FORWARD.** The single visible leaf sits on the RIGHT half of
   *   the bounds rect (`computeBounds`: `left = middle.x - pageWidth / 2 -
   *   pageWidth`), so `left + width / 2` is that leaf's own left edge — which
   *   is exactly the spine a forward fold pivots on. Also unchanged.
   * - **Portrait BACK.** The spine is the visible leaf's RIGHT edge, one whole
   *   `pageWidth` further along, and nothing moved the axis there. The frame
   *   was mirrored about the leaf's LEFT edge instead, so the entire visible
   *   leaf mapped to *negative* local x: touching its left edge already read
   *   `x = 0`, a 30 px inward drag read `-30` and **57.5 % progress**, and
   *   `Flip.stopMove` commits on `pos.x <= 0` — so every portrait back drag,
   *   however small, turned the page and could never snap back. The same
   *   displacement moved the geometry it drew: the leaf underneath starts at
   *   local `{ x: pageWidth }`, which converted to a global x one `pageWidth`
   *   off the left of the visible page.
   *
   * This is the same split the `rtl` fix (I2) introduced, applied one level
   * down: `direction` here is already the **geometric** fold side (see
   * {@link Render.direction}), and this method answers the only remaining
   * geometric question — *which leaf's spine is that side pivoting on*.
   *
   * Expressed as a shifted `left` rather than as a second formula on purpose:
   * the forward and inverse conversions live in two files and both derive the
   * origin from `left + width / 2`, so re-anchoring the rect keeps them exact
   * inverses of each other by construction. Nothing here touches
   * {@link Render.getRect} — the public {@link PageFlip.getBoundsRect} keeps
   * meaning "the notional two-page area of the book", which is what layout,
   * hit-testing, `simpleDraw` and the hard-page spine all read it as.
   */
  private getFoldRect(direction: FlipDirection): PageRect {
    const rect = this.getRect();

    return direction === FlipDirection.BACK && this.orientation === Orientation.PORTRAIT
      ? { ...rect, left: rect.left + rect.pageWidth }
      : rect;
  }

  /**
   * Casting the coordinates of the corners of the rectangle in the coordinates relative to the window
   *
   * @param {RectPoints} rect - Coordinates of the corners of the rectangle relative to the work page
   * @param {FlipDirection} direction  - Current flipping direction
   *
   * @returns {RectPoints} Coordinates of the corners of the rectangle relative to the window
   */
  public convertRectToGlobal(rect: RectPoints, direction?: FlipDirection): RectPoints {
    const dir = direction ?? this.direction;

    return {
      topLeft: this.convertPointToGlobal(rect.topLeft, dir),
      topRight: this.convertPointToGlobal(rect.topRight, dir),
      bottomLeft: this.convertPointToGlobal(rect.bottomLeft, dir),
      bottomRight: this.convertPointToGlobal(rect.bottomRight, dir),
    };
  }

  /**
   * Draw inner shadow to the hard page
   */
  private drawHardInnerShadow(shadow: Shadow): void {
    const rect = this.getRect();

    const progress = shadow.progress > 100 ? 200 - shadow.progress : shadow.progress;

    let innerShadowSize = ((100 - progress) * (2.5 * rect.pageWidth)) / 100 + 20;
    if (innerShadowSize > rect.pageWidth) innerShadowSize = rect.pageWidth;

    let newStyle =
      `display:block;z-index:${this.getSettings().startZIndex + 5};` +
      `width:${innerShadowSize}px;height:${rect.height}px;` +
      `background:linear-gradient(to right,rgba(0,0,0,${(shadow.opacity * progress) / 100}) 5%,rgba(0,0,0,0) 100%);` +
      `left:${rect.left + rect.width / 2}px;transform-origin:0 0;`;

    newStyle +=
      (this.getDirection() === FlipDirection.FORWARD && shadow.progress > 100) ||
      (this.getDirection() === FlipDirection.BACK && shadow.progress <= 100)
        ? 'transform:translate3d(0,0,0);'
        : 'transform:translate3d(0,0,0) rotateY(180deg);';

    this.hardInnerShadow.style.cssText = newStyle;
  }

  /**
   * Draw outer shadow to the hard page
   */
  private drawHardOuterShadow(shadow: Shadow): void {
    const rect = this.getRect();

    const progress = shadow.progress > 100 ? 200 - shadow.progress : shadow.progress;

    let shadowSize = ((100 - progress) * (2.5 * rect.pageWidth)) / 100 + 20;
    if (shadowSize > rect.pageWidth) shadowSize = rect.pageWidth;

    let newStyle =
      `display:block;z-index:${this.getSettings().startZIndex + 4};` +
      `width:${shadowSize}px;height:${rect.height}px;` +
      `background:linear-gradient(to left,rgba(0,0,0,${shadow.opacity}) 5%,rgba(0,0,0,0) 100%);` +
      `left:${rect.left + rect.width / 2}px;transform-origin:0 0;`;

    newStyle +=
      (this.getDirection() === FlipDirection.FORWARD && shadow.progress > 100) ||
      (this.getDirection() === FlipDirection.BACK && shadow.progress <= 100)
        ? 'transform:translate3d(0,0,0) rotateY(180deg);'
        : 'transform:translate3d(0,0,0);';

    this.hardShadow.style.cssText = newStyle;
  }

  /**
   * Draw inner shadow to the soft page
   */
  private drawInnerShadow(shadow: Shadow): void {
    const pageRect = this.pageRect;
    if (pageRect === null) return;

    const rect = this.getRect();

    const innerShadowSize = (shadow.width * 3) / 4;
    const shadowTranslate = this.getDirection() === FlipDirection.FORWARD ? innerShadowSize : 0;

    const shadowDirection = this.getDirection() === FlipDirection.FORWARD ? 'to left' : 'to right';

    const shadowPos = this.convertPointToGlobal(shadow.pos);

    const angle = shadow.angle + (3 * Math.PI) / 2;

    const clip = [pageRect.topLeft, pageRect.topRight, pageRect.bottomRight, pageRect.bottomLeft];

    let polygon = 'polygon( ';
    for (const p of clip) {
      let g =
        this.getDirection() === FlipDirection.BACK
          ? {
              x: -p.x + shadow.pos.x,
              y: p.y - shadow.pos.y,
            }
          : {
              x: p.x - shadow.pos.x,
              y: p.y - shadow.pos.y,
            };

      g = rotatePoint(g, { x: shadowTranslate, y: 100 }, angle);

      polygon += `${g.x}px ${g.y}px, `;
    }
    polygon = polygon.slice(0, -2);
    polygon += ')';

    this.innerShadow.style.cssText =
      `display:block;z-index:${this.getSettings().startZIndex + 10};` +
      `width:${innerShadowSize}px;height:${rect.height * 2}px;` +
      `background:linear-gradient(${shadowDirection},rgba(0,0,0,${shadow.opacity}) 5%,rgba(0,0,0,0.05) 15%,rgba(0,0,0,${shadow.opacity}) 35%,rgba(0,0,0,0) 100%);` +
      `transform-origin:${shadowTranslate}px 100px;` +
      `transform:translate3d(${shadowPos.x - shadowTranslate}px,${shadowPos.y - 100}px,0) rotate(${angle}rad);` +
      `clip-path:${polygon};-webkit-clip-path:${polygon};`;
  }

  /**
   * Draw outer shadow to the soft page
   */
  private drawOuterShadow(shadow: Shadow): void {
    const rect = this.getRect();

    const shadowPos = this.convertPointToGlobal({ x: shadow.pos.x, y: shadow.pos.y });

    const angle = shadow.angle + (3 * Math.PI) / 2;
    const shadowTranslate = this.getDirection() === FlipDirection.BACK ? shadow.width : 0;

    const shadowDirection = this.getDirection() === FlipDirection.FORWARD ? 'to right' : 'to left';

    const clip = [
      { x: 0, y: 0 },
      { x: rect.pageWidth, y: 0 },
      { x: rect.pageWidth, y: rect.height },
      { x: 0, y: rect.height },
    ];

    let polygon = 'polygon( ';
    for (const p of clip) {
      let g =
        this.getDirection() === FlipDirection.BACK
          ? {
              x: -p.x + shadow.pos.x,
              y: p.y - shadow.pos.y,
            }
          : {
              x: p.x - shadow.pos.x,
              y: p.y - shadow.pos.y,
            };

      g = rotatePoint(g, { x: shadowTranslate, y: 100 }, angle);

      polygon += `${g.x}px ${g.y}px, `;
    }

    polygon = polygon.slice(0, -2);
    polygon += ')';

    this.outerShadow.style.cssText =
      `display:block;z-index:${this.getSettings().startZIndex + 10};` +
      `width:${shadow.width}px;height:${rect.height * 2}px;` +
      `background:linear-gradient(${shadowDirection},rgba(0,0,0,${shadow.opacity}),rgba(0,0,0,0));` +
      `transform-origin:${shadowTranslate}px 100px;` +
      `transform:translate3d(${shadowPos.x - shadowTranslate}px,${shadowPos.y - 100}px,0) rotate(${angle}rad);` +
      `clip-path:${polygon};-webkit-clip-path:${polygon};`;
  }

  /**
   * Draw left static page
   */
  private drawLeftPage(): void {
    if (this.orientation === Orientation.PORTRAIT || this.leftPage === null) return;

    if (
      this.direction === FlipDirection.BACK &&
      this.flippingPage !== null &&
      this.flippingPage.getDrawingDensity() === PageDensity.HARD
    ) {
      setZIndexIfChanged(this.leftPage.getElement(), String(this.getSettings().startZIndex + 5));

      this.leftPage.setHardDrawingAngle(180 + this.flippingPage.getHardAngle());
      this.leftPage.draw(this.flippingPage.getDrawingDensity());
    } else {
      this.leftPage.simpleDraw(PageOrientation.LEFT);
    }
  }

  /**
   * Draw right static page
   */
  private drawRightPage(): void {
    if (this.rightPage === null) return;

    if (
      this.direction === FlipDirection.FORWARD &&
      this.flippingPage !== null &&
      this.flippingPage.getDrawingDensity() === PageDensity.HARD
    ) {
      setZIndexIfChanged(this.rightPage.getElement(), String(this.getSettings().startZIndex + 5));

      this.rightPage.setHardDrawingAngle(180 + this.flippingPage.getHardAngle());
      this.rightPage.draw(this.flippingPage.getDrawingDensity());
    } else {
      this.rightPage.simpleDraw(PageOrientation.RIGHT);
    }
  }

  /**
   * Draw the next page at the time of flipping.
   * Skip only when the mover is the bottom page (hard-cover), never on
   * portrait BACK as a direction — that skip is the duplicate-current-page bug.
   */
  private drawBottomPage(): void {
    const bottomPage = this.bottomPage;

    if (bottomPage === null) return;
    if (!shouldDrawBottomPage(this.flippingPage, bottomPage)) return;

    const tempDensity =
      this.flippingPage !== null ? this.flippingPage.getDrawingDensity() : undefined;

    setZIndexIfChanged(bottomPage.getElement(), String(this.getSettings().startZIndex + 3));

    bottomPage.draw(tempDensity);
  }

  /**
   * Rendering action on each requestAnimationFrame call. The entire rendering
   * process is performed only in this method.
   *
   * Body order is load-bearing: clear → left → right → bottom → flipping
   * zIndex+draw → shadows. `protected` so test harnesses can override it.
   */
  protected drawFrame(): void {
    this.clear();

    this.drawLeftPage();

    this.drawRightPage();

    this.drawBottomPage();

    const flippingPage = this.flippingPage;

    if (flippingPage !== null) {
      setZIndexIfChanged(flippingPage.getElement(), String(this.getSettings().startZIndex + 5));

      flippingPage.draw();
    }

    const shadow = this.shadow;

    if (shadow !== null && flippingPage !== null) {
      if (flippingPage.getDrawingDensity() === PageDensity.SOFT) {
        this.drawOuterShadow(shadow);
        this.drawInnerShadow(shadow);
      } else {
        this.drawHardOuterShadow(shadow);
        this.drawHardInnerShadow(shadow);
      }
    }
  }

  /**
   * Working set for the current frame: left / right / flipping / bottom, plus
   * the owner of any temporary-copy mover (so the owner stays booked while the
   * clone is drawn and `hideTemporaryCopy` runs when the clone leaves).
   */
  private collectWorkingSet(): Set<Page> {
    const set = new Set<Page>();
    for (const page of [this.leftPage, this.rightPage, this.flippingPage, this.bottomPage]) {
      if (page === null) continue;
      set.add(page);
      const owner = page.getCopyOwner();
      if (owner !== null) set.add(owner);
    }
    return set;
  }

  /**
   * Delta clear (PLAN-3.1 B3.2). Only pages that left the working set since the
   * last frame lose `--shown` / have their temporary copy hidden. Never walks
   * the live collection — a steady-state `drawFrame` must not touch `getPages`.
   */
  private clear(): void {
    const current = this.collectWorkingSet();

    for (const page of this.lastShown) {
      if (current.has(page)) continue;

      // Hide by REMOVING the shown class, not by writing `display:none`
      // inline — and certainly not by wiping cssText, which took the
      // consumer's own inline styles with it every frame.
      removeClass(page.getElement(), '--shown');

      // Temporary-copy trap: the mover is the CLONE; cleanup runs on the owner.
      const owner = page.getCopyOwner();
      if (owner !== null) {
        owner.hideTemporaryCopy();
      } else if (
        page.getTemporaryCopy() !== null &&
        page.getTemporaryCopy() !== this.flippingPage
      ) {
        // Owner left the set while still holding a clone that is not the
        // current mover (stale after a slot swap). Same hide the full-scan
        // clear used to perform per page.
        page.hideTemporaryCopy();
      }
    }

    this.lastShown = current;
  }

  /**
   * Full cleanup of the retained shown-set before discarding it (`reload`,
   * `cancelAnimation`, collection replacement via `releasePages`). Iterates
   * `lastShown` plus the current page slots — never the live collection.
   * Not per-frame.
   */
  private sweepShownSet(): void {
    const victims = new Set(this.lastShown);
    for (const page of [this.leftPage, this.rightPage, this.flippingPage, this.bottomPage]) {
      if (page === null) continue;
      victims.add(page);
      const owner = page.getCopyOwner();
      if (owner !== null) victims.add(owner);
    }

    for (const page of victims) {
      removeClass(page.getElement(), '--shown');
      const owner = page.getCopyOwner();
      if (owner !== null) {
        owner.hideTemporaryCopy();
      } else {
        // Real leaf: drop any clone it still owns. The clone half is handled
        // via copyOwner above; this covers an owner present without its clone
        // still sitting in `victims` (clone already detached).
        page.hideTemporaryCopy();
      }
    }

    this.lastShown.clear();
  }
}

function isSafariUserAgent(): boolean {
  if (typeof navigator === 'undefined' || !navigator.userAgent) {
    return false;
  }
  return isWebKitUserAgent(navigator.userAgent);
}

/**
 * R6: does this user agent identify a **WebKit** engine?
 *
 * The thing `isSafari()` gates (`Page`) is the workaround for
 * webkit#126207, a WebKit rendering bug — so the question is the engine, not
 * the brand. The old test, `/Version\/[\d.]+.*Safari/`, answered neither:
 *
 * - **False positive, the reported defect.** Android System WebView stamps a
 *   frozen `Version/4.0` and ends `… Chrome/117.0.0.0 Mobile Safari/537.36`.
 *   It is Blink. Every Capacitor / Cordova / React Native Android book was
 *   taking a clip-path fallback for a bug its engine does not have.
 * - **False negative, found alongside it.** iOS Chrome (`CriOS/`), Firefox
 *   (`FxiOS/`), Edge (`EdgiOS/`) and bare `WKWebView` hosts emit **no**
 *   `Version/` token at all, yet are all WebKit by App Store policy — so the
 *   browsers that *do* have the bug were being skipped.
 *
 * The order below is the whole logic and is load-bearing:
 *
 *  1. A Chromium brand token (`Chrome/`, `Chromium/`, `Edg/`, `OPR/`) means
 *     Blink — this is what rejects Android WebView, and it must be tested
 *     before anything else, because that UA also carries `Safari/`.
 *     `EdgiOS/` and `CriOS/` deliberately do not match `Edg\/` / `Chrome\/`.
 *  2. Desktop Firefox is Gecko; iOS Firefox (`FxiOS/`) is not.
 *  3. Any iOS device is WebKit whatever the brand says. This precedes the
 *     `Safari/` check because an embedded `WKWebView` often omits it.
 *  4. Otherwise require the real WebKit pair (`AppleWebKit/` + `Safari/`),
 *     which covers macOS Safari, WebKitGTK/Epiphany and Playwright's WebKit
 *     build, and rejects jsdom (`AppleWebKit/537.36 … jsdom/26`, no `Safari/`).
 */
function isWebKitUserAgent(ua: string): boolean {
  if (/Chrome\/|Chromium\/|Edg\/|OPR\//.test(ua)) return false;
  if (/Firefox\//.test(ua) && !/FxiOS\//.test(ua)) return false;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /AppleWebKit\//.test(ua) && /Safari\//.test(ua);
}
