/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Render } from '../Render/Render';
import { GET_COLLECTION } from '../internal';
import { COMMIT_TURN, EMIT_STATE, EMIT_TURN_PROGRESS, SET_SPREAD_INDEX } from '../internal';
import { foldSide, Orientation } from '../Render/Render';
import type { PageFlip } from '../PageFlip';
import { pointsBetween } from '../Helper';
import type { PageRect, Point } from '../BasicTypes';
import { FlipCalculation } from './FlipCalculation';
import type { Page } from '../Page/Page';
import { PageDensity } from '../Page/Page';
import { portraitCurlLocal } from '../geometry';
import { effectiveFlippingTime } from '../reducedMotion';
import { PageFlipError } from '../errors';
import { FlipCorner, FlipDirection, FlippingState } from './enums';

export { FlipCorner, FlipDirection, FlippingState } from './enums';

/**
 * Class representing the flipping process
 */
export class Flip {
  private readonly render: Render;
  private readonly app: PageFlip;

  private flippingPage: Page | null = null;
  private bottomPage: Page | null = null;

  private calc: FlipCalculation | null = null;

  /**
   * Bumped every time a turn or fold begins.
   *
   * A completion callback captures it and refuses to tear down state that
   * belongs to a LATER turn — see `animateFlippingTo`.
   */
  private turnGeneration = 0;

  /**
   * Why the last turn was refused, for {@link PageFlip.requestTurn} to report.
   *
   * `boundary` — there is no spread that way — was the only refusal a relative
   * turn could have, so `requestTurn` hard-coded it. `superseded` is a second
   * one, and reporting it as `boundary` would tell a consumer the book is at
   * its end when it is not. Read-and-clear, so a stale reason cannot attach to
   * a later refusal.
   */
  private refusal: 'boundary' | 'superseded' = 'boundary';

  private state: FlippingState = FlippingState.READ;

  /**
   * The **semantic** direction of the turn in flight: which way the page index
   * moves, i.e. which of `turnToNextPage` / `turnToPrevPage` commits it.
   *
   * It cannot be read back off `calc`, because `FlipCalculation` is handed the
   * *geometric* side instead (`foldSide`) so the fold follows the finger under
   * `direction: 'rtl'`. Under `ltr` the two are always equal; under `rtl` they
   * are always opposites, and taking the commit from the geometric one would
   * turn RTL drags the wrong way round.
   */
  private turnDirection: FlipDirection = FlipDirection.FORWARD;

  /**
   * Where an in-flight `flipToPage` intends to land, expressed as the spread
   * index the one-step commit has to *step off from* (target ∓ 1).
   *
   * It lives here rather than in the collection because the collection's index
   * is public: parking the phantom there for the whole animation is what let a
   * second `flipToPage` read a spread the book was not on. `null` for every
   * relative turn — `flipNext`, a drag, a click — which lands one spread over
   * from wherever the book actually is.
   */
  private pendingTarget: number | null = null;

  /**
   * Pages whose *drawing* density this turn overrode, so it can be put back.
   * See `applyLandscapeDensity`.
   */
  private densityOverrides: Page[] = [];

  /**
   * Instant turns (`flippingTime: 0` / reduced motion) run their final `do()`
   * synchronously inside `startAnimation`. Suppress `turnProgress` for that
   * path — an instant turn has no frames for a scrubber to track.
   */
  private suppressProgress = false;

  constructor(render: Render, app: PageFlip) {
    this.render = render;
    this.app = app;
  }

  /**
   * Called when the page folding (User drags page corner)
   *
   * @param globalPos - Touch Point Coordinates (relative window)
   */
  public fold(globalPos: Point): void {
    // V1. A fold the RENDERER is animating is machine-driven — a corner peel-in
    // or a snap-back — and never the reader's. A drag has no animation of its
    // own, so an animation running when a drag arrives is always somebody
    // else's fold, and reusing it is the defect:
    //
    //  - **The direction is stale.** Leaving a hovered corner starts a
    //    snap-back that only clears `calc` at `onAnimateEnd`, so for up to
    //    `flippingTime` afterwards the hover's calculation is still live. A
    //    drag begun in that window skipped `start()` entirely and folded with
    //    the HOVERED corner's direction — measured on a 200x300 book, a BACK
    //    drag on the left edge continued the right corner's FORWARD fold.
    //  - **Two things drive one fold.** The snap-back keeps firing frames
    //    against the finger, and its `needReset` then wipes `calc` MID-DRAG,
    //    so the gesture dies partway through with no release.
    //
    // The same rule settles the other machine-driven fold: grabbing a page
    // mid-TURN. That turn's `onAnimateEnd` commits unconditionally, so the page
    // used to turn no matter what the finger did with it — the reader caught
    // the leaf, dragged it back, and the book advanced anyway. Cancelling hands
    // the leaf over, and `stopMove()` then decides commit-or-return from where
    // the reader actually left it, which is what it does for every other drag.
    if (this.render.isAnimating()) {
      this.render.cancelAnimation();
      this.reset();
    }

    // I1. The state is entered only once `start()` has agreed to the turn.
    // Announcing USER_FOLD first meant a *refused* fold — a forward drag on
    // the last spread, or an ordinary right-edge drag at page 0 under
    // `direction: 'rtl'` — left `calc` null, so `do()` no-opped and
    // `stopMove()` returned early. Nothing put the state back, and the book
    // stayed in USER_FOLD for the rest of its life: `showCorner`'s
    // READ/FOLD_CORNER guard then failed forever (corner hover dead), and
    // `UI.onPointerMove`'s `!== READ` test stayed true, so every touchmove
    // called `preventDefault()` and mobile scrolling over the book stopped.
    if (this.calc === null && !this.start(globalPos)) {
      // The refused direction may have interrupted a running turn above.
      // `reset()` clears its calculation but does not change FLIPPING, and a
      // recognized swipe releases through userStop(..., true), which skips
      // stopMove(). Hand the state back here, including for that release path.
      this.setState(FlippingState.READ);
      return;
    }

    const generation = this.turnGeneration;

    this.setState(FlippingState.USER_FOLD);

    // AN5, confirmed against the built engine. `setState` dispatches
    // synchronously, and a `changeState('user_fold')` listener that starts a
    // turn installs its own calculation — which the `do()` below then DRAGS,
    // because it is the calculation `this.calc` now points at. Measured: the
    // nested turn's position moved from {x:170,y:30} to {x:155,y:8} before its
    // own animation had run a single frame.
    //
    // This is the AN4 rule at the third and last place turn setup hands control
    // to consumer code. A fold cannot supersede anything of its own, so there is
    // nothing to refuse here — the nested turn simply owns the calculation now,
    // and the reader's finger does not get to move it.
    if (this.turnGeneration !== generation) return;

    this.do(this.render.convertToPage(globalPos));
  }

  /**
   * Page turning with animation
   *
   * @param globalPos - Touch Point Coordinates (relative window)
   */
  public flip(globalPos: Point, direction?: FlipDirection): boolean {
    // No `disableFlipByClick` check here any more: that is a policy about
    // clicks, and `PageFlip.userStop` is the only path that has one. Keeping a
    // copy here meant a blocked click returned a bare `false` that nobody
    // could tell apart from "there is no next page".
    return this.runFlip(globalPos, direction, null);
  }

  /**
   * The one turn-starting path. `target` is the absolute spread destination for
   * `flipToPage` and `null` for every relative turn.
   *
   * The order here is load-bearing: an already-running animation is finished
   * *before* `pendingTarget` is overwritten, so the outgoing turn commits its
   * own destination rather than the incoming one.
   */
  private runFlip(
    globalPos: Point,
    direction: FlipDirection | undefined,
    target: number | null,
  ): boolean {
    // the flipping process is already running
    if (!this.finishOutgoingTurn()) {
      this.refusal = 'superseded';
      return false;
    }

    // THE PHANTOM SPREAD IS INSTALLED FOR `start()` AND FOR NOTHING ELSE.
    //
    // It exists so `getFlippingPage` / `getBottomPage` pick the DESTINATION
    // leaves rather than the neighbouring ones, which is a fact only `start()`
    // needs. It used to be installed by `flipToPage` around this whole call,
    // which meant it was still installed when `setState(FLIPPING)` below
    // dispatched to consumer code — so a turn started from that listener chose
    // its own flipping and bottom pages from a spread the book was not on, and
    // with `flippingTime: 0` committed off it. Measured: `flip(5)` whose
    // `changeState` listener called `flipNext()` left
    // `getCurrentPageIndex() === 5` and `getCurrentSpreadIndex() === 0` — two
    // public getters contradicting each other.
    //
    // `finally`, so a throw out of `start()` cannot strand it either.
    const collection = this.app[GET_COLLECTION]();
    const restoreSpread = target === null ? null : collection.getCurrentSpreadIndex();

    // A fast swipe can request a semantic direction different from the fold
    // the pointer briefly opened. If that request is refused at a boundary,
    // start() resets calc but the old fold remains in Render until cancelled.
    const hadUserFold = this.state === FlippingState.USER_FOLD && this.calc !== null;
    let started: boolean;
    try {
      if (target !== null) collection[SET_SPREAD_INDEX](target);
      started = this.start(globalPos, direction);
    } finally {
      if (restoreSpread !== null) collection[SET_SPREAD_INDEX](restoreSpread);
    }

    if (!started) {
      if (hadUserFold) this.render.cancelAnimation();
      this.setState(FlippingState.READ);
      return false;
    }

    // AFTER `start()`, because `start()` opens with `reset()` and `reset()` now
    // drops the target. Setting it first — as this did — meant the turn's own
    // setup wiped it on the way past.
    this.pendingTarget = target;

    const calc = this.calc;
    if (calc === null) return false;

    // This turn's own stamp, taken from `start()`. Everything below belongs to
    // it, and the next line hands control to consumer code.
    const generation = this.turnGeneration;

    const rect = this.getBoundsRect();

    this.setState(FlippingState.FLIPPING);

    // AN4. `setState` dispatches `changeState` SYNCHRONOUSLY, and this one lands
    // in the worst possible window: `start()` has installed a calculation but
    // `animateFlippingTo` has not installed an animation yet. A listener that
    // calls `flipNext()` from it therefore reaches `finishOutgoingTurn()`, which
    // sees a live `calc` but no animation to finish, concludes nothing was
    // superseded, and takes the book — while this call is still holding a
    // reference to the calculation it just replaced.
    //
    // What happened next, reproduced against the built engine: the outer call
    // resumed, ran `calc.calc()` on its now-orphaned calculation, and handed
    // `animateFlippingTo` a generation that had already moved on to the nested
    // turn — so its `startAnimation` force-finished the NESTED animation with
    // the outer turn's frames. First `flipNext()` returned `true`, committed
    // page 1 and left `state: read` with a ghost animation; the second
    // committed page 2 immediately and page 3 at completion. Two commits for one
    // request, and a `false` the caller never saw.
    //
    // AN1's guard cannot cover this: it runs before `start()`, and the window
    // opens after. This is the same rule applied at the only other point in a
    // turn's setup where the engine calls out to consumer code.
    if (this.turnGeneration !== generation) {
      this.refusal = 'superseded';
      return false;
    }

    const corner = calc.getCorner() === FlipCorner.BOTTOM ? 'bottom' : 'top';
    // SAME local curl for forward and back. BACK looks right on screen
    // because convertToGlobal mirrors. Do not send to.x past +pageWidth.
    const curl = portraitCurlLocal(rect.pageWidth, rect.height, corner);

    calc.calc(curl.from);

    // A programmatic turn IS the full turn by construction, so it gets the
    // configured `flippingTime` exactly — not a fraction of it derived from
    // where the corner point happens to sit (Puddlebend Issue 4).
    this.animateFlippingTo(curl.from, curl.to, true, true, 'full');
    return true;
  }

  /**
   * Commit the turn already in flight, and report whether THIS call still owns
   * the book afterwards.
   *
   * `finishAnimation()` is not a quiet cleanup. It runs the outgoing turn's
   * completion callback, which commits the page and emits `flip`
   * **synchronously** — and a listener is entitled to start the next turn from
   * that event (auto-advance, a controlled `page` prop, `flipNext()` inside
   * `onFlip`). By the time control comes back here, that nested turn is fully
   * installed: its own `calc`, its own flipping page, its own running
   * animation, its own `turnGeneration`.
   *
   * The generation guard inside `animateFlippingTo`'s callback cannot see this.
   * It fires when the callback finds the world moved on underneath it, and here
   * the callback has already returned; what moves on is the CALLER. Measured on
   * the built engine, an outer `flipNext()` racing a turn whose `onFlip`
   * flipped again landed on page 3 with events [1, 2, 3] — two commits — where
   * the nested turn alone should have left the book on page 2:
   *
   *   - the outer call overwrites `pendingTarget` and, through `start()` →
   *     `reset()`, the nested turn's `calc`;
   *   - its `startAnimation` then finishes the nested turn's still-running
   *     animation against the outer call's freshly installed state, so the
   *     nested turn commits the OUTER destination;
   *   - the outer turn then commits on top of it.
   *
   * The nested turn is the reader's most recent intent, so it wins and this
   * call is refused. The alternative — letting the outer call clobber it — is
   * what produced the double commit, and there is no ordering in which both
   * can be honoured, because the outer call's own point and direction were
   * computed against a spread the book has since left.
   */
  private finishOutgoingTurn(): boolean {
    if (this.calc === null) return true;

    const generation = this.turnGeneration;
    this.render.finishAnimation();

    return this.turnGeneration === generation;
  }

  /**
   * @internal Read-and-clear the reason the last turn was refused. Only
   * meaningful immediately after a `false` from `flip` / `flipNext` /
   * `flipPrev`; see {@link Flip.refusal}.
   */
  public takeRefusal(): 'boundary' | 'superseded' {
    const reason = this.refusal;
    this.refusal = 'boundary';
    return reason;
  }

  /**
   * Start the flipping process. Find direction and corner of flipping. Creating an object for calculation.
   *
   * @param {Point} globalPos - Touch Point Coordinates (relative window)
   * @param {FlipDirection} forcedDirection - Direction for programmatic turns.
   *   User-originated points must omit it so `rtl` hit-testing applies.
   *
   * @returns {boolean} True if flipping is possible, false otherwise
   */
  public start(globalPos: Point, forcedDirection?: FlipDirection): boolean {
    this.reset();

    const bookPos = this.render.convertToBook(globalPos);
    const rect = this.getBoundsRect();

    // Find the direction of flipping
    const direction = forcedDirection ?? this.getDirectionByPoint(bookPos);

    // Find the active corner
    const flipCorner = bookPos.y >= rect.height / 2 ? FlipCorner.BOTTOM : FlipCorner.TOP;

    if (!this.checkDirection(direction)) return false;

    // Setup failures are not caught here. The engine's own typed failures
    // (`PageFlipError` — a boundary, a bad spread) are reported by
    // `PageFlip.requestTurn` as `turnRejected`; anything else is a genuine
    // defect and must surface. Upstream swallowed both, so a broken book just
    // refused to turn with nothing in the console — the silent-failure class
    // §4.6 exists to remove.
    this.flippingPage = this.app[GET_COLLECTION]().getFlippingPage(direction);
    this.bottomPage = this.app[GET_COLLECTION]().getBottomPage(direction);

    // In landscape, the neighbouring page must take the flipped page's density.
    if (this.render.getOrientation() === Orientation.LANDSCAPE) {
      this.applyLandscapeDensity(direction, this.flippingPage);
    }

    // `direction` is semantic from here down to `setDirection`, which is the
    // one place the `rtl` mirror is applied (see `foldSide`). Everything above
    // — the boundary check, the page selection, the density neighbour — is
    // page-order arithmetic and must stay on the semantic value.
    this.render.setDirection(direction);
    this.turnDirection = direction;

    // ...and the calculation is geometry, so it takes the mirrored side. This
    // is what stops the RTL mirror from being applied a second time inside
    // `convertToPage`, which derives local x FROM the direction it is given.
    this.calc = new FlipCalculation(
      foldSide(direction, this.app.getSettings().readingDirection === 'rtl'),
      flipCorner,
      rect.pageWidth,
      rect.height,
    );
    this.turnGeneration += 1;

    return true;
  }

  /**
   * A soft page next to a hard one has to be drawn hard for the duration of the
   * turn, or the two halves of the spread disagree about how they bend.
   *
   * The override is recorded and put back by `reset()`. Upstream set it and
   * walked away: `draw()` reads the *drawing* density, so one landscape turn
   * left the neighbour permanently hard — drawn by `drawHard`, unable to curl
   * again for the life of the book, and invisible because nothing ever
   * inspected the value it had changed.
   */
  private applyLandscapeDensity(direction: FlipDirection, flippingPage: Page): void {
    const collection = this.app[GET_COLLECTION]();
    const neighbour =
      direction === FlipDirection.BACK
        ? collection.nextBy(flippingPage)
        : collection.prevBy(flippingPage);

    // Compared on the *created* density, which is what `getDensity()` returns.
    // Comparing the drawing density would see the override it just wrote and
    // stop re-marking on every later turn.
    if (neighbour === null || flippingPage.getDensity() === neighbour.getDensity()) return;

    for (const page of [flippingPage, neighbour]) {
      page.setDrawingDensity(PageDensity.HARD);
      this.densityOverrides.push(page);
    }
  }

  /**
   * Perform calculations for the current page position. Pass data to render object
   *
   * @param {Point} pagePos - Touch Point Coordinates (relative active page)
   */
  private do(pagePos: Point): void {
    const calc = this.calc;
    const bottomPage = this.bottomPage;
    const flippingPage = this.flippingPage;

    // Flipping process not started
    if (calc === null || bottomPage === null || flippingPage === null) return;

    if (calc.calc(pagePos)) {
      // Perform calculations for a specific position
      const progress = calc.getFlippingProgress();

      bottomPage.setArea(calc.getBottomClipArea());
      bottomPage.setPosition(calc.getBottomPagePosition());
      bottomPage.setAngle(0);
      bottomPage.setHardAngle(0);

      flippingPage.setArea(calc.getFlippingClipArea());
      flippingPage.setPosition(calc.getActiveCorner());
      flippingPage.setAngle(calc.getAngle());

      if (calc.getDirection() === FlipDirection.FORWARD) {
        flippingPage.setHardAngle((90 * (200 - progress * 2)) / 100);
      } else {
        flippingPage.setHardAngle((-90 * (200 - progress * 2)) / 100);
      }

      this.render.setPageRect(calc.getRect());

      this.render.setBottomPage(bottomPage);
      this.render.setFlippingPage(flippingPage);

      const shadowStart = calc.getShadowStartPoint();

      if (shadowStart !== null) {
        this.render.setShadowData(
          shadowStart,
          calc.getShadowAngle(),
          progress,
          calc.getDirection(),
        );
      } else {
        // FL4, the same family as X3: a shadow the fold can no longer compute
        // has to leave the screen. The start point is the intersection of the
        // folded leaf with the book's border, and a pose exists where there is
        // none — drag a BOTTOM corner up past the top edge of a wide, short
        // book and `getShadowStartPoint()` goes from a point to `null` between
        // one pointer move and the next.
        //
        // A bare `if` left the LAST computed shadow in `Render.shadow`, and
        // `drawFrame` repaints whatever the field holds, so the
        // shadow froze in mid-air over a leaf that had moved on, until the turn
        // ended and `animateFlippingTo` cleared it. "No shadow for this pose"
        // is a result, not an absence of one.
        this.render.clearShadow();
      }

      // turnProgress: same source as shadow progress, only while a real turn
      // (or user fold) is in flight — never FOLD_CORNER, never instant turns.
      if (
        !this.suppressProgress &&
        (this.state === FlippingState.USER_FOLD || this.state === FlippingState.FLIPPING)
      ) {
        const clamped = Math.min(1, Math.max(0, progress / 100));
        const direction = this.turnDirection === FlipDirection.FORWARD ? 'next' : 'prev';
        this.app[EMIT_TURN_PROGRESS](clamped, direction);
      }
    }
  }

  /**
   * Turn to the specified page number (with animation)
   *
   * Throws `PageFlipError` when the request cannot be satisfied. Returns
   * quietly, having animated nothing, when it ALREADY is — i.e. when `page`
   * shares the current spread, which in landscape includes its partner half.
   * That is a success, not a rejection; see the comment on the guard below.
   *
   * @param {number} page - New page number
   * @param {FlipCorner} corner - Active page corner when turning
   */
  /**
   * MIN-10. Returns `false` when a newer turn overtook this one.
   *
   * Both `return` sites below are deliberate non-errors — nothing about the
   * request was invalid and the book IS moving, just not where this call asked.
   * But `void` meant the caller could not tell, so the React binding's
   * controlled `page` effect saw no change, did not re-run, and left the book
   * resting somewhere the prop had not asked for with nothing reported. A hole
   * in "`page` without `onPageChange` is a genuinely locked book".
   */
  public flipToPage(page: number, corner: FlipCorner): boolean {
    const collection = this.app[GET_COLLECTION]();

    // Finish any turn already in flight *before* reading the index. Policy:
    // finish-then-restart. A second `flipToPage` used to read the phantom index
    // the first one had written, compute its direction from a spread the book
    // was not on, and land somewhere neither call asked for (`flip(5)` then
    // `flip(2)` landed on 3). Refusing the second call was the alternative, but
    // the controlled-`page` binding legitimately issues turns faster than they
    // animate, and §4.6 says the caller must end up where it last asked.
    // ...and if finishing it let a `flip` listener start its own turn, that
    // turn is the later request and this one is abandoned — see
    // {@link Flip.finishOutgoingTurn}. Returning is deliberate where the rest
    // of this method throws: `PageFlip.flip` calls it directly, so a throw
    // reaches the consumer uncaught, and the React binding drives it from the
    // controlled `page` prop on every change. "A newer turn overtook you" is
    // not a `PageFlipError` — nothing about the request was invalid, and the
    // book is moving, just not where this call asked. Without this guard the
    // phantom index below is computed against a spread the nested turn has
    // already left, `runFlip` refuses, and the caller gets a spurious
    // `FLIP_SETUP` throw for a book that is working correctly.
    if (!this.finishOutgoingTurn()) return false;

    const current = collection.getCurrentSpreadIndex();
    const next = collection.getSpreadIndexByPage(page);

    if (next == null) {
      throw new PageFlipError(
        `Cannot flip to page ${page}: page is not in any spread`,
        'PAGE_NOT_IN_SPREAD',
      );
    }
    // F7. Asking for a page that is ALREADY on screen is a no-op, deliberately,
    // and it is neither an error nor a rejection. This is the declaration of
    // that, because an undeclared no-op on a public method is indistinguishable
    // from a bug — which is how it was recorded.
    //
    // The postcondition of `flipToPage(p)` is "page `p` is visible". Landscape
    // spreads hold two pages, so `flip(3)` while showing `[2, 3]` already
    // satisfies it: there is nothing to animate, and the call SUCCEEDED.
    //
    // The two alternatives were both wrong for that reason:
    //
    // - **Throw.** `PageFlip.flip` calls this directly rather than through
    //   `requestTurn`, so a throw reaches the consumer uncaught, and the React
    //   binding's controlled `page` prop drives this method on every change. A
    //   consumer setting `page` to the partner half of the spread it is already
    //   on would crash rather than no-op. The `PageFlipError` contract this fork
    //   added is for a request that CANNOT be satisfied (`page` out of range, in
    //   no spread) — not for one that already is.
    // - **Emit `turnRejected`.** Nothing was rejected. Its three reasons
    //   (`boundary`, `setup`, `disabled`) all describe a refusal, the React
    //   binding forwards it to `onTurnRejected`, and consumers would see a
    //   spurious failure for a satisfied request. Widening the event's public
    //   vocabulary to say so is a product decision, not this fix's to make
    //   (AGENTS.md §5).
    //
    // Note the `finishAnimation()` above still runs: a turn already in flight is
    // committed first, so `current` is read after it lands. That is the same
    // finish-then-restart policy the rest of the method uses, and it is what
    // makes `flip(5)` immediately followed by `flip(4)` settle correctly when
    // the two share a spread.
    if (next === current) {
      // The postcondition is already satisfied, so this SUCCEEDED.
      return true;
    }

    const dir = next > current ? FlipDirection.FORWARD : FlipDirection.BACK;
    const phantom = dir === FlipDirection.FORWARD ? next - 1 : next + 1;

    // The phantom's whole lifetime is inside `runFlip` now — installed across
    // `start()`, restored before anything can observe it, re-installed for the
    // instant of the commit. This method used to install it here and unpick the
    // restore afterwards by inspecting `pendingTarget`, which could not tell
    // "the turn never started" from "an instant turn already landed" once a
    // nested turn was in the mix, and left the two spread getters disagreeing.

    // The collection's spread index is borrowed for the duration of `start()`
    // only: `getFlippingPage` / `getBottomPage` read it, and pointing it one
    // spread short of the target is what makes the *destination* pages animate
    // in rather than the neighbouring ones. It is put back before this call
    // returns and re-installed for the instant the commit needs it, so no
    // caller ever observes the phantom — that is what made
    // `getCurrentPageIndex()` and `getCurrentSpreadIndex()` disagree mid-turn,
    // and what made the *next* `flipToPage` compute its direction from it.
    let started = false;
    try {
      started = this.runFlip(this.cornerPoint(corner), dir, phantom);
    } catch (err: unknown) {
      this.pendingTarget = null;
      throw err;
    }

    // Read-and-clear HERE, because this path does not go through
    // `PageFlip.requestTurn` — `PageFlip.flip` calls this method directly. A
    // `superseded` left standing would attach itself to some unrelated later
    // refusal and report "a newer turn is running" for a book at its boundary.
    // Read-and-clear HERE, because this path does not go through
    // `PageFlip.requestTurn` — `PageFlip.flip` calls this method directly. A
    // `superseded` left standing would attach itself to some unrelated later
    // refusal and report "a newer turn is running" for a book at its boundary.
    const refusal = this.takeRefusal();

    if (!started) {
      // A turn started from this call's own `changeState('flipping')` now owns
      // the book. Returning rather than throwing, for the same reason as the
      // guard at the top: `PageFlip.flip` is driven straight from the React
      // binding's controlled `page` prop, and nothing about the request was
      // invalid — the book is moving, just not where this call asked.
      if (refusal === 'superseded') return false;

      throw new PageFlipError(`Flip setup failed for page ${page}`, 'FLIP_SETUP');
    }

    return true;
  }

  /**
   * The synthetic point a programmatic turn starts from, in **global**
   * coordinates.
   *
   * `start()` runs it through `convertToBook`, which subtracts `rect.top`, and
   * re-derives the corner from the reduced y. Passing a book-local y therefore
   * turned every BOTTOM request into a TOP one on any vertically centred book
   * — i.e. the normal `size: 'fixed'` layout, where `rect.top` is half the
   * leftover height. The BOTTOM corner was simply unreachable programmatically.
   *
   * `x` is deliberately the book's own left edge and nothing reads it: the
   * direction is forced, so `getDirectionByPoint` never runs (which is also
   * what keeps `direction: 'rtl'` from inverting a programmatic page index),
   * and the corner comes from `y` alone.
   */
  private cornerPoint(corner: FlipCorner): Point {
    const rect = this.getBoundsRect();

    return {
      x: rect.left,
      y: corner === FlipCorner.TOP ? rect.top + 1 : rect.top + rect.height - 2,
    };
  }

  /**
   * Turn to the next page (with animation)
   *
   * @param {FlipCorner} corner - Active page corner when turning
   */
  public flipNext(corner: FlipCorner): boolean {
    return this.runFlip(this.cornerPoint(corner), FlipDirection.FORWARD, null);
  }

  /**
   * Turn to the prev page (with animation)
   *
   * @param {FlipCorner} corner - Active page corner when turning
   */
  public flipPrev(corner: FlipCorner): boolean {
    return this.runFlip(this.cornerPoint(corner), FlipDirection.BACK, null);
  }

  /**
   * Called when the user has stopped flipping
   */
  public stopMove(): void {
    if (this.calc === null) {
      // A gesture that never opened a calculation — `start()` refused it at a
      // boundary — still has to hand the state back. Returning silently here
      // is the second half of the stuck-in-USER_FOLD defect: `fold()` no
      // longer announces the state early, and the release path no longer
      // assumes an announced state implies a live calculation.
      this.setState(FlippingState.READ);
      return;
    }

    const pos = this.calc.getPosition();
    const rect = this.getBoundsRect();

    const y = this.calc.getCorner() === FlipCorner.BOTTOM ? rect.height : 0;

    if (pos.x <= 0) this.animateFlippingTo(pos, { x: -rect.pageWidth, y }, true);
    else this.animateFlippingTo(pos, { x: rect.pageWidth, y }, false);
  }

  /**
   * Fold the corners of the book when the mouse pointer is over them.
   * Called when the mouse pointer is over the book without clicking
   *
   * @param globalPos
   */
  public showCorner(globalPos: Point): void {
    if (!this.checkState(FlippingState.READ, FlippingState.FOLD_CORNER)) return;

    const rect = this.getBoundsRect();
    const pageWidth = rect.pageWidth;

    if (this.isPointOnCorners(globalPos)) {
      if (this.calc === null) {
        if (!this.start(globalPos)) return;

        const calc = this.calc as FlipCalculation | null;
        if (calc === null) return;

        const generation = this.turnGeneration;

        this.setState(FlippingState.FOLD_CORNER);

        // The same window, and the most destructive of the three: everything
        // below seeds a calculation and starts an animation, and
        // `animateFlippingTo` opens by finishing whatever is running. A
        // `changeState('fold_corner')` listener that starts a turn therefore had
        // its turn FORCE-FINISHED by the resumed hover — measured on a book at
        // page 2: it committed to page 3, and the engine came to rest with
        // `state: read` and `calc: null` while a ghost animation was still
        // scheduled against nothing.
        //
        // A hover is an affordance. It must never be the thing that commits a
        // page, and it certainly must not commit someone else's turn.
        if (this.turnGeneration !== generation) return;

        // Z1. The peel is bounded by the leaf it peels.
        //
        // This size used to be a flat 50, and the fold parks at local
        // `x = pageWidth - it`. On a leaf 50px wide or narrower that parks the
        // corner AT or PAST the spine — and `stopMove()` commits on exactly
        // `pos.x <= 0`. So on a 50x300 book, hovering a corner and then moving
        // the pointer away turned the page: `showCorner`'s else-branch runs
        // `finishAnimation()` (which lands the fold on its parked pose) and then
        // `stopMove()`, which read that pose as "the reader carried this leaf
        // across the spine" and advanced the index 0 -> 1 with no click.
        //
        // Fixed at the producer, not at the commit test. `pos.x <= 0` is the
        // definition of a leaf that has crossed the spine, and it is what makes
        // a genuine drag past the middle commit; clamping or special-casing it
        // there would have to distinguish a fold that arrived from a hover from
        // one that arrived from a finger, which is a fact about the gesture, not
        // about the geometry. What was actually wrong is that a HOVER — an
        // affordance that must never commit anything — was able to synthesise a
        // committed pose. A peel is a corner-sized nub of the page, so its size
        // is a property of the page.
        //
        // Bounded on BOTH axes for the same reason: `yDest` is
        // `rect.height - it` for a BOTTOM hover, so on a leaf 50px tall or
        // shorter the bottom corner's peel animated to the TOP half of the leaf.
        // Half of each dimension keeps the parked pose strictly inside the leaf
        // and on the hovered corner's own half, and the clamp is inert at
        // ordinary proportions — a 200x300 leaf keeps the full 50.
        const cornerSize = Math.min(50, rect.pageWidth / 2, rect.height / 2);
        const yStart = calc.getCorner() === FlipCorner.BOTTOM ? rect.height - 1 : 1;

        const yDest =
          calc.getCorner() === FlipCorner.BOTTOM ? rect.height - cornerSize : cornerSize;

        // FL3. The seed has to be the same point the animation starts from.
        // It used to be hard-coded to `y: 1` — the TOP corner — while `yStart`
        // below correctly picked `rect.height - 1` for a BOTTOM hover, so the
        // first geometry the renderer was handed for a bottom-corner peel was
        // the pose of a *top*-corner peel. The book drew one frame with the
        // fold at the wrong end of the leaf and then jumped to the bottom on
        // the next, which is the visible flicker at the start of the hover.
        calc.calc({ x: pageWidth - 1, y: yStart });

        this.animateFlippingTo(
          { x: pageWidth - 1, y: yStart },
          { x: pageWidth - cornerSize, y: yDest },
          false,
          false,
        );
      } else {
        this.do(this.render.convertToPage(globalPos));
      }
    } else {
      // I9, the same ordering family as I1's fix in `fold()`: the state is
      // handed back by whoever finishes the fold, not announced ahead of it.
      //
      // This branch used to run `setState(READ)` first, then `finishAnimation()`
      // and `stopMove()` — and `stopMove()` starts the snap-back ANIMATION, with
      // `calc` still live, while the book has already told the world it is
      // reading. `UI.onPointerMove` reads READ as "not flipping", so a pointer
      // move during that snap-back re-entered `showCorner`, found `calc !== null`
      // and went straight to `do()`: the releasing fold snapped back onto the
      // pointer instead of settling.
      //
      // Nothing is lost by dropping the call. `stopMove()` settles to READ on
      // both of its paths — immediately when there is no calculation, and via
      // `animateFlippingTo`'s `needReset` when the snap-back completes — so the
      // only change is that READ is now announced when it is TRUE.
      this.render.finishAnimation();

      this.stopMove();
    }
  }

  /**
   * Starting the flipping animation process
   *
   * @param {Point} start - animation start point
   * @param {Point} dest - animation end point
   * @param {boolean} isTurned - will the page turn over, or just bring it back
   * @param {boolean} needReset - reset the flipping process at the end of the animation
   * @param {'full' | 'partial'} extent - `'full'` is a whole programmatic turn
   *   and runs for exactly the configured `flippingTime`; `'partial'` (a drag
   *   release, a hover peel) settles in proportion to the distance left.
   */
  private animateFlippingTo(
    start: Point,
    dest: Point,
    isTurned: boolean,
    needReset = true,
    extent: 'full' | 'partial' = 'partial',
  ): void {
    const points = pointsBetween(start, dest);

    // Create frames
    const frames = [];
    for (const p of points) frames.push(() => this.do(p));

    // Max-axis distance, the same measure `pointsBetween` steps by — NOT
    // `points.length`, which is capped at 4097 (see getAnimationDuration).
    const travel = Math.max(Math.abs(dest.x - start.x), Math.abs(dest.y - start.y));
    const duration =
      extent === 'full'
        ? this.getAnimationDuration(Number.POSITIVE_INFINITY)
        : this.getAnimationDuration(travel);

    const generation = this.turnGeneration;

    // Captured with the generation, and for the same reason: `onAnimateEnd`
    // emits `flip` synchronously, a listener may start the next turn from it,
    // and that turn restamps `this.turnDirection`. The commit below belongs to
    // *this* turn.
    const turnDirection = this.turnDirection;

    const onEnd = (): void => {
      // callback function
      if (!this.calc) return;

      // Read-and-clear: the intent belongs to *this* turn, whether or not it
      // ends up committing one.
      const target = this.pendingTarget;
      this.pendingTarget = null;

      if (isTurned) {
        // A `flipToPage` re-installs its phantom index for exactly this
        // instant, so the one-step commit below steps off it and lands on the
        // requested spread. Between `start()` and here the collection reported
        // the truth.
        if (target !== null) this.app[GET_COLLECTION]()[SET_SPREAD_INDEX](target);

        // The SEMANTIC direction, not `calc.getDirection()` — that one is the
        // geometric side and is inverted under `direction: 'rtl'`.
        //
        // Through the COMMIT seam, not the public methods: the publics settle
        // and carry the instant-jump barrier (B5), and this call is the very
        // commit a settle runs — routed publicly it would refuse itself.
        this.app[COMMIT_TURN](turnDirection === FlipDirection.BACK ? 'prev' : 'next');
      }

      // `turnToNextPage()` above emits `flip` SYNCHRONOUSLY, and a listener is
      // entitled to start the next turn from it (auto-advance, a controlled
      // `page` prop, a consumer calling `flipNext()` from `onFlip`). If it did,
      // `start()` has already installed a new calc, a new flipping page and a
      // new animation — and tearing down here would strip all of it, leaving a
      // running animation with no calculation that can never commit.
      //
      // `Render.finishAnimation` was fixed to preserve the new ANIMATION; this
      // is the other half, and without it that fix does nothing on the path
      // that actually occurs in production.
      if (this.turnGeneration !== generation) return;

      if (needReset) {
        // Z4, RECORDED AND NOT FIXED HERE — it cannot be, from this file.
        //
        // `Render.cancelAnimation` drops four pieces of per-turn state; this
        // path drops three. `render.pageRect` — the clip
        // `drawInnerShadow` cuts the inner shadow against —
        // survives a completed turn, so the renderer carries one turn's fold
        // geometry into the next.
        //
        // It is state hygiene, not a reproducible visual defect, and the same is
        // true of RD2 on the cancel path. `pageRect` has exactly one reader on
        // each renderer, both guarded by `shadow !== null`, and the shadow is
        // cleared on the line below. Its only writer is `do()`, which writes it
        // BEFORE `setShadowData` in the same call — so by the time a shadow
        // exists again, the rect beside it is from the same frame. There is no
        // ordering in which the stale rect can be drawn.
        //
        // Fixing it needs `Render.setPageRect(pageRect: RectPoints | null)`
        // (Render.ts:716); this agent's file scope excludes that file, so the
        // asymmetry is left visible rather than papered over with a cast.
        this.render.setBottomPage(null);
        this.render.setFlippingPage(null);
        this.render.clearShadow();

        // CLEANUP FIRST, ANNOUNCEMENT SECOND — the same ordering family as I1
        // and I9, and the last place it was still backwards.
        //
        // `setState` emits `changeState` synchronously, so a `read` listener
        // that starts a turn (the natural place to chain one — the book has
        // just come to rest) had `start()` install a fresh `calc`, flipping
        // page and animation, and then `reset()` on the next line destroyed all
        // of it. Measured: the nested `flipNext()` returned `true` with a live
        // calculation, and by the time the listener returned the state was
        // READ, `calc` was null and the page had not moved — a turn that
        // reported success and never happened.
        //
        // Nothing is lost by reordering. `reset()` touches only this turn's
        // own state, and once READ is announced this turn is finished, so
        // anything the listener installs is by definition not ours to clear.
        this.reset();
        this.setState(FlippingState.READ);
      }
    };

    // Instant path runs the final frame action synchronously inside
    // `startAnimation`; gate turnProgress for that call only.
    if (duration <= 0) {
      this.suppressProgress = true;
      try {
        this.render.startAnimation(frames, duration, onEnd);
      } finally {
        this.suppressProgress = false;
      }
    } else {
      this.render.startAnimation(frames, duration, onEnd);
    }
  }

  /**
   * Get the current calculations object. `null` while the book is at rest.
   */
  public getCalculation(): FlipCalculation | null {
    return this.calc;
  }

  /**
   * Get current flipping state
   */
  public getState(): FlippingState {
    return this.state;
  }

  private setState(newState: FlippingState): void {
    if (this.state !== newState) {
      // ASSIGNED BEFORE DISPATCH. `updateState` emits `changeState`
      // synchronously, so a listener that read `getState()` — or anything the
      // engine itself routes through it, such as `UI.onPointerMove` treating
      // READ as "not flipping" — observed the state the book was LEAVING. A
      // `changeState('read')` handler saw `fold_corner`.
      this.state = newState;
      this.app[EMIT_STATE](newState);
    }
  }

  /**
   * Direction for a *user-originated* point. `direction: 'rtl'` mirrors the
   * hit-test so the left edge turns forward, matching the swipe mapping in
   * `UI` and the keyboard mapping in the React binding. Programmatic turns
   * pass an explicit direction and never reach this.
   */
  private getDirectionByPoint(touchPos: Point): FlipDirection {
    const rect = this.getBoundsRect();
    let direction: FlipDirection = FlipDirection.FORWARD;

    // The one definition of where BACK stops and FORWARD starts. It is shared
    // with `isPointOnCorners` (I10) so the corner band cannot be derived from a
    // different boundary than the direction it will produce.
    const splitOffset = this.getDirectionSplitOffset(rect);

    if (this.render.getOrientation() === Orientation.PORTRAIT) {
      // FL2. Measured from the visible leaf's own left edge, and bounded at
      // BOTH ends. The upper bound is upstream's; the lower one is new.
      //
      // `touchPos` is in book coordinates, and in portrait the book's rect is
      // twice the leaf: its left half is phantom (`computeBounds` puts `left`
      // at `middle.x - 1.5 * pageWidth`), and the host shows blank margin
      // there. A bare `<=` therefore accepted every point to the LEFT of the
      // leaf as well, so a click in that margin started a back turn — one the
      // reader never aimed at, on a part of the page that is not the book.
      // Outside the leaf there is no meaningful direction, so those points
      // fall through to FORWARD exactly as the margin on the *right* already
      // did.
      //
      // The zone stays 2/5 of the leaf rather than the 1/2 landscape uses.
      // `rect.width / 5` is the same number (portrait `width` is exactly
      // `2 * pageWidth`), written against the phantom width by accident;
      // re-expressing it against `pageWidth` changes nothing a consumer can
      // observe and removes the coupling. Widening it to half the leaf would
      // be a behaviour change with no defect behind it, and it would remove a
      // property worth keeping — forward is the overwhelmingly common turn, so
      // biasing the split towards it is the friendlier target, and landscape's
      // even split is a consequence of the left page BEING the previous page,
      // not a rule portrait has to match.
      const leafPos = touchPos.x - this.getVisibleLeft(rect);

      if (leafPos >= 0 && leafPos <= splitOffset) {
        direction = FlipDirection.BACK;
      }
    } else if (touchPos.x < this.getVisibleLeft(rect) + splitOffset) {
      direction = FlipDirection.BACK;
    }

    if (this.app.getSettings().readingDirection === 'rtl') {
      direction = direction === FlipDirection.FORWARD ? FlipDirection.BACK : FlipDirection.FORWARD;
    }

    return direction;
  }

  /**
   * How long an animation travelling `travel` px (max-axis, matching
   * `pointsBetween`'s step count) should run.
   *
   * Puddlebend Issue 4: `flippingTime` must mean what it says on every page
   * size. Upstream normalized to a magic 1000 px — duration was
   * `(points / 1000) × flippingTime` below that — so `flippingTime: 800` ran
   * 800 ms on a ≥500 px desktop page and ~560 ms on a 350 px phone leaf: the
   * one setting silently meant different things per device, and a consumer
   * had to reverse-engineer the constant to compensate.
   *
   * The reference is now the book's OWN full turn (`2 × pageWidth`, the
   * corner-to-corner x travel): a full turn takes exactly `flippingTime`
   * everywhere, and a drag released mid-fold settles in proportion to the
   * distance it has left — near the edge it still snaps rather than crawling.
   *
   * Derived from geometric TRAVEL, not `points.length`: `pointsBetween` caps
   * its output at 4097 points, so a count-based formula silently shortened
   * (or would now shorten) turns on very large books.
   */
  private getAnimationDuration(travel: number): number {
    const settings = this.app.getSettings();
    const defaultTime = effectiveFlippingTime(settings.flippingTime, settings.respectReducedMotion);

    if (defaultTime <= 0) return 0;

    const fullTurn = 2 * this.getBoundsRect().pageWidth;

    if (fullTurn <= 0 || travel >= fullTurn) return defaultTime;

    return (travel / fullTurn) * defaultTime;
  }

  /**
   * A turn is possible only when there is another *spread* to move to.
   * Page-index arithmetic is wrong in landscape, where the last spread can
   * hold two pages: it let a forward turn start on the final spread and then
   * read past the end of the spread list.
   */
  private checkDirection(direction: FlipDirection): boolean {
    const collection = this.app[GET_COLLECTION]();

    if (direction === FlipDirection.FORWARD)
      return collection.getCurrentSpreadIndex() < collection.getSpreadCount() - 1;

    return collection.getCurrentSpreadIndex() >= 1;
  }

  /**
   * Drop any in-flight fold. Callers inside a turn use this between frames, so
   * it deliberately does NOT touch `state` — see `abandon()` for the case where
   * the pages themselves are going away.
   */
  private reset(): void {
    this.calc = null;
    this.flippingPage = null;
    this.bottomPage = null;

    // The absolute destination belongs to the TURN, so anything that destroys
    // the turn destroys it too. It used to survive: `fold()`'s V1 cancellation
    // reset the calculation and left `pendingTarget` behind, so the reader who
    // grabbed a `flip(5)` mid-flight and dragged the leaf across the spine had
    // their own one-step turn consume the stale target and land on page 5.
    // Their drag, someone else's destination.
    this.pendingTarget = null;

    this.suppressProgress = false;

    // Put back every drawing density this turn overrode. `getDensity()` is the
    // density the page was created with, so this restores rather than freezes.
    for (const page of this.densityOverrides) page.setDrawingDensity(page.getDensity());
    this.densityOverrides = [];
  }

  /**
   * Abandon an in-flight fold or turn and return to READ.
   *
   * Used when the page collection is replaced underneath an active gesture:
   * the calculation refers to pages that are about to be destroyed, so the turn
   * is dropped rather than committed.
   *
   * @internal Wiring seam for `PageFlip.replacePages` / `destroy`.
   */
  public abandon(): void {
    // RE-4. A teardown is a supersession too.
    //
    // `turnGeneration` was bumped only by `start()`, so the three reentrancy
    // guards — in `fold`, `runFlip` and `showCorner` — fired for a listener
    // that started another TURN and not for one that tore the book down. They
    // survived on the `calc === null` checks downstream, so nothing corrupted,
    // but the refusal contract lied: measured, a `changeState('flipping')`
    // listener calling `destroy()` left `flipNext()` returning TRUE with no
    // `turnRejected` at all, where the contract promises `false` plus
    // `code: 'DESTROYED'`. `runFlip` also went on to install a ghost animation
    // on a stopped render, which never completes.
    //
    // Bumping here makes one counter mean "the turn you were holding is no
    // longer yours", whether it was replaced or destroyed.
    this.turnGeneration += 1;

    // The destination goes with the turn: the pages it referred to are the ones
    // being replaced.
    this.pendingTarget = null;
    this.reset();
    this.setState(FlippingState.READ);
  }

  private getBoundsRect(): PageRect {
    return this.render.getRect();
  }

  private checkState(...states: FlippingState[]): boolean {
    for (const state of states) {
      if (this.state === state) return true;
    }

    return false;
  }

  /**
   * @internal Wiring seam for `PageFlip.userStop`, which owns the
   * `disableFlipByClick` policy so a refused click can be reported.
   */
  public isPointOnCorners(globalPos: Point): boolean {
    const rect = this.getBoundsRect();
    const pageWidth = rect.pageWidth;

    const operatingDistance = Math.sqrt(pageWidth * pageWidth + rect.height * rect.height) / 5;

    const bookPos = this.render.convertToBook(globalPos);

    // FL1. The corner bands belong to the leaves the reader can SEE, so they
    // are measured against the visible span, not against the bounds rect.
    //
    // In landscape the two are the same thing and nothing here changes. In
    // portrait the bounds rect is twice the single leaf and its left half is
    // phantom: `computeBounds` sets `left = middle.x - 1.5 * pageWidth`, so
    // `bookPos.x < operatingDistance` picked out a band that sits off the host
    // entirely — measured on a 200×300 portrait book, `left = -110` and
    // `operatingDistance = 72.1`, putting the whole "left corner" band at
    // negative page coordinates. The reader could hover-peel the FORWARD
    // corner and never the BACK one: the affordance for turning back simply
    // did not exist in portrait, and `disableFlipByClick` inherited the same
    // hole through `PageFlip.requestUserTurn`.
    //
    // Solved from here rather than from `Render.getFoldRect`: that rect
    // re-anchors on the leaf a *given fold direction* pivots about, and this
    // test runs before any direction is chosen — it is the thing that decides
    // whether a fold starts at all. What it needs is the leaf's extent, which
    // `getRect()` and `getOrientation()` already state.
    const visibleLeft = this.getVisibleLeft(rect);

    // I10. The horizontal band and the direction split were derived
    // independently and could describe different halves of the book.
    //
    // `operatingDistance` is a fifth of the page DIAGONAL and knows nothing
    // about the page's width, so it exceeds `pageWidth` on any book taller than
    // `pageWidth * sqrt(24)` — about 4.9:1. Measured on a 100x600 portrait book:
    // `pageWidth = 100`, `operatingDistance = 121.7`, and both bands then span
    // the whole leaf, so the middle of the page — the one place on it that is
    // certainly not a corner — hover-peels, and `disableFlipByClick` (which
    // gates on exactly this predicate in `PageFlip.requestUserTurn`) stops
    // restricting anything at all.
    //
    // The narrower and stranger case is a band that crosses the split: in
    // portrait, `operatingDistance` between 0.4 and 0.6 of `pageWidth` (e.g. a
    // 100x200 leaf, where it is 44.7) puts points on the FORWARD side of the
    // split inside the BACK band. The reader hovers near the leaf's left edge
    // and its right edge peels.
    //
    // Both are the same missing constraint: a corner band must not reach past
    // the boundary that decides which leaf the fold belongs to. Clamping it to
    // that boundary makes the two derivations agree BY CONSTRUCTION rather than
    // by coincidence of proportions, and at ordinary proportions the clamp is
    // inert — a 200x300 leaf keeps its 72.1 in both orientations.
    //
    // TWO BANDS, not one — but they do NOT get the same bound, and the two
    // wrong answers here are instructive enough to record.
    //
    // The first version took a single `min(operatingDistance, splitOffset)` for
    // both edges, on the reasoning that `splitOffset` is never more than half
    // the visible span so the near-side bound is always the tighter one. True
    // of the LEFT band; false of the RIGHT one, because portrait's split is
    // ASYMMETRIC — the leading 2/5 of the leaf turns BACK and the trailing 3/5
    // FORWARD. That shrank a band with no defect behind it: on a 100x200 leaf
    // `operatingDistance` is 44.7 and `splitOffset` is 40, so a point 43 px in
    // from the RIGHT edge sits 57 px into the leaf, is unambiguously FORWARD,
    // cannot cross the split, and was a valid corner hit before the clamp
    // existed. Under `disableFlipByClick` that is a corner that visibly refuses
    // to turn the page.
    //
    // The obvious repair — bound the right band by `visibleSpan - splitOffset`,
    // its own distance to the split — is worse, and this is the trap. It makes
    // the two bands MEET whenever `operatingDistance` is large: they sum to
    // exactly `visibleSpan`, leaving no gap at all. Measured on the 100x600
    // leaf this clamp exists for, the left band is 40 and the right 60, and
    // every single point on the leaf is a corner again. That is the I10 defect
    // verbatim, reintroduced by a bound that looks strictly more correct.
    //
    // So each edge takes the tighter of the two boundaries that actually
    // constrain it, and they are different boundaries:
    //
    //   - LEFT is bounded by the SPLIT. A band reaching past it would claim
    //     points the direction test hands to the other leaf (I10).
    //   - RIGHT is bounded by the MIDLINE. The split is on the far side of the
    //     midline in portrait and on it in landscape, so it can never bind
    //     here — carrying it as a second term would be a dead branch, the C11
    //     mistake in a `Math.min`. What binds is the same rule Z2 applies on
    //     the y axis: neither band may cross the middle of the leaf, so the two
    //     can never overlap.
    //
    // At ordinary proportions both are inert — a 200x300 leaf keeps 72.1 on
    // both sides — which is the property that says this is a clamp and not a
    // narrowing of every book's corners.
    const splitOffset = this.getDirectionSplitOffset(rect);
    const visibleSpan = rect.width - visibleLeft;

    // Named by EDGE, not by direction. `getDirectionSplitOffset` is documented
    // as the geometry of the line before any `rtl` mirror, which flips which
    // side MEANS back; these are the two sides of that line, and they are the
    // same two sides in both reading directions.
    const leftBand = Math.min(operatingDistance, splitOffset);
    const rightBand = Math.min(operatingDistance, visibleSpan / 2);

    // Z2, the same missing constraint on the other axis. `operatingDistance` is
    // a fifth of the DIAGONAL and knows nothing about the page's height either,
    // so it exceeds half the height on any leaf wider than about 1.14x its
    // height — on a 400x100 leaf it is 82.5 against a half-height of 50, and the
    // top band and the bottom band then both cover the whole leaf.
    //
    // The horizontal clamp (I10) was justified by the direction split, and the
    // vertical axis was left alone on the grounds that it has no counterpart.
    // It does: `start()` assigns the corner with
    // `bookPos.y >= rect.height / 2 ? BOTTOM : TOP`. A band that reaches past
    // that midline claims points which, once the fold is accepted, are handed
    // to the OTHER corner — the same "two derivations of the same boundary"
    // defect I10 fixed, so this is a consistency fix and not a new policy.
    //
    // Half the height is therefore the bound, and the midline itself belongs to
    // neither band. That mirrors the horizontal case exactly: in landscape the
    // split IS half the visible span, so the two x bands already tile the book
    // with the middle line excluded, and "the middle of the page is not a
    // corner" is a property this predicate already had at ordinary proportions.
    //
    // What this deliberately does NOT do is make the middle of a very wide leaf
    // a non-corner in y. Once `operatingDistance` exceeds half the height, the
    // two half-height bands still tile the leaf, so on a 400x100 book everything
    // inside the x band except that one line is still a corner. That is the
    // diagonal heuristic being a poor fit for extreme aspect ratios, and
    // replacing it (a per-axis band, a fraction of each side) is a product
    // decision about how big a corner IS — AGENTS.md §5, not this fix's to make.
    // The `disableFlipByClick` consequence is bounded by the x clamp, which does
    // exclude the middle of a wide leaf.
    const cornerHeight = Math.min(operatingDistance, rect.height / 2);

    // V2. INCLUSIVE on all four edges, because the direction test is.
    //
    // These bounds and `getDirectionByPoint` are the two halves of one
    // question — is this point on the book, and if so which leaf does it turn —
    // and they disagreed about the book's own boundary. `getDirectionByPoint`
    // accepts `leafPos >= 0`, and `start()` reads `bookPos.y >= rect.height / 2`
    // for the corner, so the leaf's left column and the book's top row are
    // valid points that produce a real direction; `>` refused them here.
    //
    // Under `disableFlipByClick` that is a click which the engine agrees is a
    // BACK click on the book, and refuses anyway. One-pixel edges are exactly
    // what a reader hits aiming at the very corner of the page, and on a touch
    // screen the rounded pointer coordinate lands there routinely.
    //
    // The right and bottom edges take the same treatment for the same reason:
    // `bookPos.x === rect.width` is the last column of the leaf, is FORWARD by
    // the direction test, and was likewise not a corner.
    return (
      bookPos.x >= visibleLeft &&
      bookPos.y >= 0 &&
      bookPos.x <= rect.width &&
      bookPos.y <= rect.height &&
      (bookPos.x < visibleLeft + leftBand || bookPos.x > rect.width - rightBand) &&
      (bookPos.y < cornerHeight || bookPos.y > rect.height - cornerHeight)
    );
  }

  /**
   * Book-x of the left edge of the span the reader can actually SEE.
   *
   * Zero in landscape, where the bounds rect *is* the two visible leaves. In
   * portrait the bounds rect is twice the single leaf and its left half is
   * phantom (`computeBounds` puts `left` at `middle.x - 1.5 * pageWidth`), so
   * the visible leaf starts one `pageWidth` in. See FL1 in
   * {@link Flip.isPointOnCorners}.
   */
  private getVisibleLeft(rect: PageRect): number {
    return this.render.getOrientation() === Orientation.PORTRAIT ? rect.width - rect.pageWidth : 0;
  }

  /**
   * Distance from {@link Flip.getVisibleLeft} to the boundary between the BACK
   * region and the FORWARD region — the single definition of the direction
   * split, before any `rtl` mirror (which flips the *meaning* of the two sides,
   * never the geometry of the line between them).
   *
   * Landscape splits the visible span in half, because the left leaf IS the
   * previous page. Portrait gives BACK the leading 2/5 of the single leaf — see
   * FL2 in {@link Flip.getDirectionByPoint} for why the two differ.
   *
   * Shared with {@link Flip.isPointOnCorners} so a corner band can never be
   * measured against a boundary the direction does not use (I10).
   */
  private getDirectionSplitOffset(rect: PageRect): number {
    return this.render.getOrientation() === Orientation.PORTRAIT
      ? (rect.pageWidth * 2) / 5
      : rect.width / 2;
  }
}
