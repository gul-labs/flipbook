/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared render loop — rAF scheduling, animation frame discipline, and
 * orientation measurement on the concrete `Render`.
 *
 * Covers three defects from `docs/CANVAS_FIRST_CLASS.md`:
 *
 *  - **C4** the final animation frame was dropped whenever rAF skipped a frame;
 *  - **C5** a zero-size container voted PORTRAIT and emitted `changeOrientation`;
 *  - **C11** `RENDER_NOT_READY` was an unreachable branch in the public surface;
 *  - **R1** `finishAnimation()` replayed a final frame the loop already played;
 *  - **R2** the frame clock was stamped after the frame actions, so anything
 *    chaining a turn began one frame in the past;
 *  - **R3** `start()` called `requestAnimationFrame` unguarded.
 *
 * The loop is driven through a fake `requestAnimationFrame` so frame timestamps
 * are exact: a real rAF cannot be asked to drop a frame on demand, and a test
 * that stubbed `startAnimation` would be testing nothing (AGENTS.md §2).
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ADOPT_ORIENTATION, GET_UI, INVALIDATE_FOLD_GEOMETRY } from '../src/internal';

import { PageFlipError } from '../src/errors';
import { FlipDirection } from '../src/Flip/Flip';
import { Render, Orientation } from '../src/Render/Render';
import type { PageFlip } from '../src/PageFlip';
import { Settings, SizeMode, type FlipSetting } from '../src/Settings';

class TestRender extends Render {
  public frameDraws = 0;

  public constructor(app: PageFlip, setting: FlipSetting, element: HTMLElement) {
    super(app, setting, element);
  }

  protected drawFrame(): void {
    this.frameDraws += 1;
  }

  public reload(): void {
    /* nothing to reload in the harness */
  }

  /** Test seam for the protected scheduler hook — see R8. */
  public wake(): void {
    this.requestFrame();
  }
}

type Harness = {
  render: TestRender;
  /** Run one animation frame at the given timestamp. */
  tick: (timer: number) => void;
  /**
   * Is a frame scheduled? R8: the loop parks when there is nothing to draw, so
   * this is the difference between "the book is at rest" and "the book has
   * stopped drawing and cannot restart".
   */
  pending: () => boolean;
  /** The measured box the render reads through `getDistElement()`. */
  box: { offsetWidth: number; offsetHeight: number };
  /**
   * The spy the fake app exposes under the `ADOPT_ORIENTATION` symbol. Kept
   * under a plain name HERE because it is the test's own handle, not the seam:
   * only the object handed to `Render` needs the symbol key.
   */
  updateOrientation: ReturnType<typeof vi.fn>;
};

let pendingFrame: ((timer: number) => void) | null = null;
let nextRafId = 0;

function makeHarness(
  userSetting: Partial<FlipSetting> = {},
  box = { offsetWidth: 0, offsetHeight: 0 },
): Harness {
  const setting = new Settings().resolve({ width: 200, height: 300, ...userSetting });
  const updateOrientation = vi.fn();

  const app = {
    [GET_UI]: () => ({ getDistElement: () => box }),
    getSettings: () => setting,
    [ADOPT_ORIENTATION]: updateOrientation,
    [INVALIDATE_FOLD_GEOMETRY]: () => undefined,
    isDestroyed: () => false,
  } as unknown as PageFlip;

  const render = new TestRender(app, setting, document.createElement('div'));

  const tick = (timer: number): void => {
    const frame = pendingFrame;
    if (frame === null) throw new Error('no frame scheduled — did start() run?');
    pendingFrame = null;
    frame(timer);
  };

  return { render, tick, box, updateOrientation, pending: () => pendingFrame !== null };
}

beforeEach(() => {
  pendingFrame = null;
  nextRafId = 0;

  globalThis.requestAnimationFrame = ((cb: (timer: number) => void): number => {
    pendingFrame = cb;
    nextRafId += 1;
    return nextRafId;
  }) as typeof globalThis.requestAnimationFrame;

  globalThis.cancelAnimationFrame = ((): void => {
    pendingFrame = null;
  }) as typeof globalThis.cancelAnimationFrame;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Five frames, 100 ms each, logging into a shared trace. */
function fiveFrames(trace: string[]): Array<() => void> {
  return [0, 1, 2, 3, 4].map((i) => () => trace.push(`frame:${String(i)}`));
}

describe('C4 — the final animation frame is never dropped', () => {
  test('a skipped frame still plays the last frame, exactly once, before the callback', () => {
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    // First frame lands on index 0, then the tab is throttled and the clock
    // jumps clean past the end of the list.
    tick(0);
    tick(100_000);

    // Reverted fix: ['frame:0', 'end'] — the leaf commits a turn whose final
    // geometry was never drawn.
    expect(trace).toEqual(['frame:0', 'frame:4', 'end']);
  });

  test('the last frame is not replayed when the loop lands on it normally', () => {
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    for (const t of [0, 100, 200, 300, 400]) tick(t);
    // The tick after the last frame is the one that commits.
    tick(500);

    // A "fix" that unconditionally replays the last frame in the overshoot
    // branch produces ['frame:0'..'frame:4', 'frame:4', 'end'] — the leaf
    // re-runs its final geometry, and any frame with a side effect runs twice.
    expect(trace).toEqual(['frame:0', 'frame:1', 'frame:2', 'frame:3', 'frame:4', 'end']);
  });

  test('the animation ends exactly once even if the loop keeps running', () => {
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    tick(0);
    tick(900);
    // R8: the loop parks once the turn is over, so "keeps running" now has to
    // be asked for. Each `requestFrame()` buys exactly one more frame — and the
    // point of the test is that none of them re-commits the finished turn.
    render.wake();
    tick(1000);
    render.wake();
    tick(1100);

    expect(trace.filter((entry) => entry === 'end')).toHaveLength(1);
    expect(trace.filter((entry) => entry === 'frame:4')).toHaveLength(1);
  });

  test('an instant turn (flippingTime: 0) still runs the last frame synchronously', () => {
    // CLAUDE.md invariant: `startAnimation` with a zero duration commits inside
    // the call, before it returns — the C4 guard must not defer that.
    const { render } = makeHarness();
    const trace: string[] = [];

    render.startAnimation(fiveFrames(trace), 0, () => trace.push('end'));

    expect(trace).toEqual(['frame:4', 'end']);
  });

  test('finishAnimation still commits a turn the loop never reached', () => {
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    tick(0);
    render.finishAnimation();

    expect(trace).toEqual(['frame:0', 'frame:4', 'end']);

    // …and it is idempotent: a second call has no animation left to commit.
    render.finishAnimation();
    expect(trace.filter((entry) => entry === 'end')).toHaveLength(1);
  });
});

describe('C5 — a zero-size container is not an observation', () => {
  test('hiding and re-showing a measured book emits nothing', () => {
    // 400 wide is exactly two 200-wide pages: landscape.
    const { render, box, updateOrientation } = makeHarness(
      {},
      {
        offsetWidth: 400,
        offsetHeight: 300,
      },
    );

    render.update();
    expect(updateOrientation).toHaveBeenCalledExactlyOnceWith(Orientation.LANDSCAPE);

    const measured = { ...render.getRect() };

    // display: none — every box collapses to 0.
    box.offsetWidth = 0;
    box.offsetHeight = 0;
    render.update();

    // Reverted fix: `0 < minWidth * 2` votes PORTRAIT and this emits.
    expect(updateOrientation).toHaveBeenCalledTimes(1);
    expect(render.getOrientation()).toBe(Orientation.LANDSCAPE);
    // A fix that suppresses only the event still corrupts the geometry: the
    // retained bounds must be the last *measured* ones, not a rect of zeros.
    expect(render.getRect()).toEqual(measured);

    // Visible again, same size: still nothing to say.
    box.offsetWidth = 400;
    box.offsetHeight = 300;
    render.update();

    expect(updateOrientation).toHaveBeenCalledTimes(1);
    expect(render.getRect()).toEqual(measured);
  });

  test('a real resize across the portrait threshold still emits, once', () => {
    const { render, box, updateOrientation } = makeHarness(
      {},
      {
        offsetWidth: 400,
        offsetHeight: 300,
      },
    );

    render.update();
    updateOrientation.mockClear();

    // Narrower than two pages: portrait, and that is a real measurement.
    box.offsetWidth = 300;
    render.update();

    expect(updateOrientation).toHaveBeenCalledExactlyOnceWith(Orientation.PORTRAIT);
    expect(render.getOrientation()).toBe(Orientation.PORTRAIT);

    // Hidden while portrait: retained, silent. Recovery after that must work.
    box.offsetWidth = 0;
    box.offsetHeight = 0;
    render.update();
    expect(render.getOrientation()).toBe(Orientation.PORTRAIT);

    box.offsetWidth = 400;
    box.offsetHeight = 300;
    render.update();

    expect(updateOrientation).toHaveBeenCalledTimes(2);
    expect(updateOrientation).toHaveBeenLastCalledWith(Orientation.LANDSCAPE);
    expect(render.getRect().pageWidth).toBe(200);
  });

  test('a responsive book behaves the same way', () => {
    const { render, box, updateOrientation } = makeHarness(
      {
        sizing: SizeMode.RESPONSIVE,
        minWidth: 150,
        maxWidth: 2000,
        minHeight: 100,
        maxHeight: 2000,
      },
      { offsetWidth: 600, offsetHeight: 400 },
    );

    render.update();
    expect(updateOrientation).toHaveBeenCalledExactlyOnceWith(Orientation.LANDSCAPE);

    const measured = { ...render.getRect() };

    box.offsetWidth = 0;
    box.offsetHeight = 0;
    render.update();

    expect(updateOrientation).toHaveBeenCalledTimes(1);
    expect(render.getRect()).toEqual(measured);
  });

  test('a zero height alone is also no observation', () => {
    // A collapsed flex child can report a width and no height; the geometry
    // that falls out of it is just as degenerate.
    const { render, box, updateOrientation } = makeHarness(
      {},
      {
        offsetWidth: 400,
        offsetHeight: 300,
      },
    );

    render.update();
    const measured = { ...render.getRect() };
    updateOrientation.mockClear();

    box.offsetHeight = 0;
    render.update();

    expect(updateOrientation).not.toHaveBeenCalled();
    expect(render.getRect()).toEqual(measured);
  });
});

describe('C11 — geometry is always answerable', () => {
  test('a never-measured book returns bounds instead of throwing RENDER_NOT_READY', () => {
    // Mounted inside `display: none`: no box has ever existed. The old code
    // documented a `RENDER_NOT_READY` error here that could not fire; the
    // decision is that it must not start firing either — a hidden book that
    // throws out of the rAF loop is worse than one that reports a flat rect.
    const { render } = makeHarness();

    expect(() => render.getRect()).not.toThrow();

    const rect = render.getRect();
    for (const value of Object.values(rect)) expect(Number.isFinite(value)).toBe(true);
  });

  test('the render loop runs on an unmeasured book without throwing', () => {
    const { render, tick } = makeHarness();

    render.start();
    expect(() => {
      tick(0);
      // R8: an unmeasured book has nothing to redraw, so the loop parks after
      // the first frame. Asking for the second one is what keeps this a test
      // about `getRect()` not throwing rather than about the scheduler.
      render.wake();
      tick(16);
    }).not.toThrow();

    expect(render.frameDraws).toBe(2);
  });

  test('the first real measurement replaces the unmeasured bounds', () => {
    const { render, box, updateOrientation } = makeHarness();

    render.getRect();
    box.offsetWidth = 400;
    box.offsetHeight = 300;
    render.update();

    expect(render.getRect().pageWidth).toBe(200);
    expect(render.getRect().left).toBe(0);
    expect(updateOrientation).toHaveBeenLastCalledWith(Orientation.LANDSCAPE);
  });
});

describe('R1 — a frame action runs at most once per animation', () => {
  test('finishAnimation does not replay a final frame the loop already played', () => {
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    // The loop lands on every frame including the last, but the tick that
    // would commit never arrives — a pointer event forces the commit instead
    // (`Flip.ts:65`, `Flip.ts:314`).
    for (const t of [0, 100, 200, 300, 400]) tick(t);
    render.finishAnimation();

    // Reverted fix: ['frame:0'..'frame:4', 'frame:4', 'end'] — the final frame
    // action runs twice, which is only survivable while every frame action is
    // an idempotent `this.do(p)`.
    expect(trace).toEqual(['frame:0', 'frame:1', 'frame:2', 'frame:3', 'frame:4', 'end']);
  });

  test('the callback still fires exactly once when the final frame is skipped', () => {
    // The guard must suppress only the *frame*, never the commit: dropping
    // `onAnimateEnd` here would leave the turn uncommitted forever.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    for (const t of [0, 100, 200, 300, 400]) tick(t);
    render.finishAnimation();
    render.finishAnimation();

    expect(trace.filter((entry) => entry === 'end')).toHaveLength(1);
    expect(trace.filter((entry) => entry === 'frame:4')).toHaveLength(1);
  });

  test('a side-effecting frame action is counted, not assumed idempotent', () => {
    // The defect is only benign because frame actions happen to be idempotent
    // today. Pin the property itself rather than the symptom.
    const { render, tick } = makeHarness();
    let sideEffects = 0;
    const frames = [() => void 0, () => void 0, () => (sideEffects += 1)];

    render.start();
    render.startAnimation(frames, 300, () => void 0);

    tick(0);
    tick(100);
    tick(200);
    render.finishAnimation();

    expect(sideEffects).toBe(1);
  });
});

describe('R2 — a chained animation starts on the current frame clock', () => {
  /** Five frames, tagged, so two animations can share one trace. */
  function tagged(trace: string[], tag: string): Array<() => void> {
    return [0, 1, 2, 3, 4].map((i) => () => trace.push(`${tag}:${String(i)}`));
  }

  test('an animation started from onAnimateEnd is not stamped one frame in the past', () => {
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(tagged(trace, 'A'), 500, () => {
      trace.push('A:end');
      render.startAnimation(tagged(trace, 'B'), 500, () => trace.push('B:end'));
    });

    tick(0); // A frame 0
    tick(500); // overshoot: A frame 4, A:end, and B is chained from there
    tick(600); // B is 100 ms old — one frame in

    // Reverted fix: B is stamped `startedAt = 0` (the previous tick's
    // timestamp), so at 600 ms it is already 6 frames old, overshoots on its
    // very first tick, and the chained turn plays only its last frame:
    // ['A:0', 'A:4', 'A:end', 'B:4', 'B:end'].
    expect(trace).toEqual(['A:0', 'A:4', 'A:end', 'B:1']);
  });

  test('an animation started from inside a frame action is stamped with that frame', () => {
    // The `onAnimateEnd` path alone can be "fixed" by stamping the timer in the
    // overshoot branch only. This is the other half: a frame action that starts
    // a turn (a queued flip, an auto-advance timer landing mid-animation).
    const { render, tick } = makeHarness();
    const trace: string[] = [];
    const framesB = tagged(trace, 'B');

    const framesA = [0, 1, 2, 3, 4].map((i) => () => {
      trace.push(`A:${String(i)}`);
      if (i === 1) render.startAnimation(framesB, 500, () => trace.push('B:end'));
    });

    render.start();
    render.startAnimation(framesA, 500, () => trace.push('A:end'));

    tick(1000); // A binds here (R5) and plays frame 0
    tick(1100); // A frame 1 — which supersedes A with B
    tick(1200); // B is 100 ms old

    // `startAnimation` finishes A first (R1: frame 4 had not been played), then
    // stamps B. Reverted fix: B is stamped 1000, not 1100, so at 1200 it is two
    // frames in and the trace ends 'B:2'.
    //
    // R8: A is started before the first tick rather than after a warm-up tick.
    // A warm-up tick no longer leaves a live frame clock behind — with nothing
    // to draw the loop parks and `park()` clears the clock — so the animation
    // that used to be *stamped* would now bind lazily, and the test would be
    // measuring the binding rather than the stamping it is named for.
    expect(trace).toEqual(['A:0', 'A:1', 'A:4', 'A:end', 'B:1']);
  });

  test('the instant path is unaffected by the frame clock', () => {
    // CLAUDE.md invariant: `flippingTime: 0` commits synchronously inside
    // `startAnimation`, with no frame clock involved at all.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    tick(12_345);
    render.startAnimation(fiveFrames(trace), 0, () => trace.push('end'));

    expect(trace).toEqual(['frame:4', 'end']);
  });

  test('C4 overshoot handling still holds with the clock stamped first', () => {
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    tick(1000);
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    tick(1000);
    tick(99_000);

    expect(trace).toEqual(['frame:0', 'frame:4', 'end']);
  });
});

describe('R3 — a DOM-less environment fails with a typed error', () => {
  test('start() throws PageFlipError NO_ANIMATION_FRAME, not ReferenceError', () => {
    const { render } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });

    Reflect.deleteProperty(globalThis, 'requestAnimationFrame');

    // Reverted fix: a raw `ReferenceError: requestAnimationFrame is not
    // defined`, which is neither catchable by code nor typed like every other
    // boundary failure in this engine.
    expect(() => {
      render.start();
    }).toThrow(PageFlipError);

    let code: string | null = null;
    try {
      render.start();
    } catch (error) {
      code = (error as PageFlipError).code;
    }
    expect(code).toBe('NO_ANIMATION_FRAME');
  });

  test('the guard runs before any side effect', () => {
    // A guard placed after `this.update()` still throws the right error, but
    // only after emitting an orientation for a book that will never render.
    const { render, updateOrientation } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });

    Reflect.deleteProperty(globalThis, 'requestAnimationFrame');

    expect(() => {
      render.start();
    }).toThrow(PageFlipError);
    expect(updateOrientation).not.toHaveBeenCalled();
  });

  test('stop() stays silent when cancelAnimationFrame is missing', () => {
    // The asymmetry is deliberate: teardown must never throw.
    const { render } = makeHarness();

    render.start();
    Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');

    expect(() => {
      render.stop();
    }).not.toThrow();
  });

  test('a normal environment still starts the loop', () => {
    const { render, tick } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });

    expect(() => {
      render.start();
    }).not.toThrow();
    tick(0);
    expect(render.frameDraws).toBe(1);
  });
});

/* ------------------------------------------------------------------------- *
 * R4 — R7. See docs/CANVAS_FIRST_CLASS.md.
 * ------------------------------------------------------------------------- */

describe('R4 — a turn chained from onAnimateEnd survives', () => {
  /** Five frames, tagged, so two animations can share one trace. */
  function tagged(trace: string[], tag: string): Array<() => void> {
    return [0, 1, 2, 3, 4].map((i) => () => trace.push(`${tag}:${String(i)}`));
  }

  test('finishAnimation does not discard an animation its callback installed', () => {
    // The live shape: a pointer event forces a commit (`Flip.ts:65`,
    // `Flip.ts:314`), `onAnimateEnd` turns the page, and the consumer's
    // `onFlip` handler chains the next turn.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(tagged(trace, 'A'), 500, () => {
      trace.push('A:end');
      render.startAnimation(tagged(trace, 'B'), 500, () => trace.push('B:end'));
    });

    tick(1100); // A binds here and plays frame 0
    render.finishAnimation(); // forced commit: A:4, A:end, and B is chained

    // Reverted fix: the trailing `this.animation = null` runs AFTER
    // `onAnimateEnd`, so B is thrown away the instant it is created. The trace
    // ends at 'A:end' and no further tick ever plays a B frame — the book is
    // frozen mid-turn with no animation and no pending commit.
    expect(trace).toEqual(['A:0', 'A:4', 'A:end']);

    // B was stamped from the frame clock of tick(1100) — the R2 rule, and the
    // clock is live because A was still animating — so at 1200 it is one frame
    // in. (The warm-up tick this test used to open with is gone: R8 parks an
    // idle loop, so it no longer establishes anything.)
    tick(1200);
    tick(1300);
    expect(trace).toEqual(['A:0', 'A:4', 'A:end', 'B:1', 'B:2']);

    // …and B still commits under its own steam.
    tick(1700);
    expect(trace).toContain('B:end');
  });

  test('the chained animation is a real animation, not just a surviving field', () => {
    // A subtly wrong variant — restoring the captured animation afterwards
    // (`this.animation = animation` / `if (this.animation === null)
    // this.animation = animation`) — leaves a *field* set but re-installs the
    // COMPLETED animation, whose `lastPlayedIndex` is already the last frame.
    // It would then commit A a second time. Count the commits.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(tagged(trace, 'A'), 500, () => {
      trace.push('A:end');
      render.startAnimation(tagged(trace, 'B'), 500, () => trace.push('B:end'));
    });

    tick(1100);
    render.finishAnimation();
    // 1600 is B's commit; there is no 1700 tick because the loop parks on the
    // frame that commits (R8) and a parked loop schedules nothing.
    for (const t of [1200, 1300, 1400, 1500, 1600]) tick(t);

    expect(trace.filter((entry) => entry === 'A:end')).toHaveLength(1);
    expect(trace.filter((entry) => entry === 'B:end')).toHaveLength(1);
    expect(trace).toEqual(['A:0', 'A:4', 'A:end', 'B:1', 'B:2', 'B:3', 'B:4', 'B:end']);
  });

  test('an instant turn chained from an instant turn also survives', () => {
    // The second site of the same defect, and the one most likely to fire in
    // production: `flippingTime: 0` / `prefers-reduced-motion` is exactly where
    // consumers auto-advance. A fix applied to `finishAnimation()` alone leaves
    // `startAnimation`'s own trailing `this.animation = null` to discard the'
    // chained turn.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();

    // The instant turn commits synchronously and chains an ANIMATED turn.
    render.startAnimation(tagged(trace, 'A'), 0, () => {
      trace.push('A:end');
      render.startAnimation(tagged(trace, 'B'), 500, () => trace.push('B:end'));
    });

    expect(trace).toEqual(['A:4', 'A:end']);

    // Reverted fix (either site): B was discarded, these ticks draw nothing.
    // (B binds on the first frame it is drawn on — R5 — because the loop had
    // not ticked yet; under R8 that is also what a parked loop gives it.)
    tick(1100);
    tick(1200);
    expect(trace).toEqual(['A:4', 'A:end', 'B:0', 'B:1']);
  });

  test('finishAnimation still commits exactly once with nothing chained', () => {
    // The detach must not change the ordinary path: one final frame, one
    // callback, and idempotent on a second call.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    tick(100);
    render.finishAnimation();
    render.finishAnimation();

    expect(trace).toEqual(['frame:0', 'frame:4', 'end']);
  });
});

describe('R5 — an animation never inherits a stale frame clock', () => {
  test('a turn started before the loop’s first tick animates from frame 0', () => {
    // rAF timestamps are `performance.now()` — milliseconds since page load,
    // so the very first one is whatever the page has been alive for. A turn
    // started in the window between `start()` and that first callback used to
    // be stamped `startedAt = 0`.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    tick(98_765); // the first real frame of a page that has been up 98 seconds

    // Reverted fix: `startedAt = 0`, so frameIndex = round(98765/100) = 988 —
    // the clock overshoots the whole list on the first tick and the turn plays
    // instantly: ['frame:4', 'end'].
    //
    // A naive "reset `this.timer = 0` in `start()`" fix produces exactly the
    // same trace, because 0 is what the field already held. That is why the
    // timestamp here is deliberately not near zero.
    expect(trace).toEqual(['frame:0']);

    tick(98_865);
    tick(98_965);
    expect(trace).toEqual(['frame:0', 'frame:1', 'frame:2']);
  });

  test('a restarted loop does not reuse the previous run’s clock', () => {
    // Phase 7's parked scheduler makes this the common case rather than a
    // one-frame window: park at rest, resume on the next turn.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    tick(1000);
    // No second tick: with nothing to draw the loop parks after the first one
    // (R8), which is precisely the "parked scheduler" this test anticipated.
    render.stop();

    // …the tab is backgrounded for a minute, then a turn resumes the loop.
    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    tick(61_016);

    // Reverted fix: `this.timer` still holds 1016, so the resumed loop's first
    // timestamp is 60 seconds past `startedAt` and the turn plays instantly.
    expect(trace).toEqual(['frame:0']);
  });

  test('an animation stamped by a running loop keeps its stamp', () => {
    // The subtly wrong variant: rebinding unconditionally (`startedAt = timer`
    // rather than `??=`). Every tick would reset the clock and the animation
    // would sit on frame 0 forever, never advancing and never committing.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    // R8: the animation is installed BEFORE the first tick, so tick(5000) is
    // the frame it binds on — after which it is an animation "stamped by a
    // running loop", which is what this test is about. (Starting it after a
    // warm-up tick would no longer produce one: an idle loop parks and clears
    // the clock, so it would bind lazily instead.)
    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    for (const t of [5000, 5100, 5200, 5300, 5400, 5500]) tick(t);

    expect(trace).toEqual(['frame:0', 'frame:1', 'frame:2', 'frame:3', 'frame:4', 'end']);
  });

  test('lazy binding does not defeat the C4 overshoot commit', () => {
    // A turn bound lazily must still commit when the loop then drops frames —
    // the guard the fix must not trade away.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    tick(70_000); // binds here
    tick(200_000); // and overshoots from there

    expect(trace).toEqual(['frame:0', 'frame:4', 'end']);
  });

  test('the instant path still commits before the loop has ever ticked', () => {
    // CLAUDE.md invariant. `startedAt` is never consulted on this path, so a
    // null clock must not turn an instant turn into a deferred one.
    const { render } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(fiveFrames(trace), 0, () => trace.push('end'));

    expect(trace).toEqual(['frame:4', 'end']);
  });
});

describe('R6 — WebKit detection, not brand detection', () => {
  /**
   * The discrimination table. `expected` is "does this engine have
   * webkit#126207, i.e. is it WebKit?" — which is what `isSafari()` gates.
   *
   * Provenance:
   *  - `playwright-webkit` / `playwright-chromium` were **measured** in this
   *    repo on 2026-08-29 by launching `@playwright/test`'s bundled browsers'
   *    and reading `navigator.userAgent`. These two are what `pnpm test:e2e`
   *    actually runs, so they are the only rows that are not transcriptions.
   *  - The Android System WebView row is the format documented by Chromium
   *    (`Version/4.0` frozen, plus a `Chrome/<version>` token), which is what
   *    Capacitor, Cordova and React Native render into. It is the reported
   *    defect.
   *  - The iOS rows use the brand tokens Apple's WKWebView-only policy forces
   *    third-party browsers to use: `CriOS/`, `FxiOS/`, `EdgiOS/`.
   *  - The remaining rows are standard published UA formats for those
   *    browsers.
   */
  const table: Array<{ name: string; ua: string; expected: boolean }> = [
    // ---- must be TRUE: really WebKit, really has the bug -------------------
    {
      name: 'macOS Safari 17',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      expected: true,
    },
    {
      name: 'iOS Safari 17',
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      expected: true,
    },
    {
      name: 'iPadOS Safari (desktop-class UA)',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      expected: true,
    },
    {
      // No `Version/` token at all — the old regex MISSED this, so iOS Chrome
      // users were denied a workaround for a bug their engine does have.
      name: 'iOS Chrome (CriOS — WKWebView underneath)',
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0.6261.62 Mobile/15E148 Safari/604.1',
      expected: true,
    },
    {
      name: 'iOS Firefox (FxiOS — WKWebView underneath)',
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15',
      expected: true,
    },
    {
      name: 'iOS Edge (EdgiOS — must not match the desktop `Edg/` token)',
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/122.0.2365.86 Version/17.0 Mobile/15E148 Safari/604.1',
      expected: true,
    },
    {
      name: 'iOS embedded WKWebView (no Safari token)',
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      expected: true,
    },
    {
      name: 'WebKitGTK / GNOME Web',
      ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      expected: true,
    },
    {
      // MEASURED, 2026-08-29, @playwright/test 1.62.1 on darwin.
      name: 'playwright-webkit (measured)',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
      expected: true,
    },

    // ---- must be FALSE: Blink or Gecko, no such bug -----------------------
    {
      // THE REPORTED DEFECT. `Version/4.0` is frozen boilerplate; the engine
      // is Blink. Matched by the old regex.
      name: 'Android System WebView (Capacitor / Cordova / React Native)',
      ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/117.0.0.0 Mobile Safari/537.36',
      expected: false,
    },
    {
      name: 'legacy Android WebView 4.4 (also stamps Version/4.0)',
      ua: 'Mozilla/5.0 (Linux; Android 4.4.2; Nexus 5 Build/KOT49H) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/30.0.0.0 Mobile Safari/537.36',
      expected: false,
    },
    {
      name: 'Android Chrome',
      ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36',
      expected: false,
    },
    {
      name: 'macOS Chrome',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      expected: false,
    },
    {
      name: 'Windows Edge',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.2365.66',
      expected: false,
    },
    {
      name: 'Opera',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OPR/108.0.0.0',
      expected: false,
    },
    {
      name: 'macOS Firefox (Gecko)',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0',
      expected: false,
    },
    {
      // MEASURED, 2026-08-29. Note it is `HeadlessChrome/`, not `Chrome/` —
      // the substring still identifies Blink, and on a `Macintosh` UA with
      // `AppleWebKit/537.36 … Safari/537.36` nothing else would.
      name: 'playwright-chromium headless (measured)',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.7922.34 Safari/537.36',
      expected: false,
    },
    {
      name: 'jsdom',
      ua: 'Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.0.0',
      expected: false,
    },
  ];

  for (const row of table) {
    test(`${row.name} → isSafari() === ${String(row.expected)}`, () => {
      // Detection runs in the constructor and is read through the public
      // getter, so this exercises the real path rather than a private helper.
      vi.stubGlobal('navigator', { userAgent: row.ua });
      const { render } = makeHarness();

      expect(render.isSafari()).toBe(row.expected);
    });
  }

  test('the Android WebView UA is the one the old regex got wrong', () => {
    // Kept as its own named case so a future "simplification" back to
    // `/Version\/[\d.]+.*Safari/` fails on the defect itself, not just on the
    // table. A test that only asserted "real Safari is detected" would pass
    // against the broken regex — this is the negative control.
    const androidWebView =
      'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/117.0.0.0 Mobile Safari/537.36';

    expect(/Version\/[\d.]+.*Safari/.test(androidWebView)).toBe(true);

    vi.stubGlobal('navigator', { userAgent: androidWebView });
    expect(makeHarness().render.isSafari()).toBe(false);
  });

  test('a DOM-less environment reports false rather than throwing', () => {
    vi.stubGlobal('navigator', undefined);
    expect(makeHarness().render.isSafari()).toBe(false);

    vi.stubGlobal('navigator', { userAgent: '' });
    expect(makeHarness().render.isSafari()).toBe(false);
  });
});

describe('R7 — the loop closure has no temporal dead zone', () => {
  /**
   * A synchronous `requestAnimationFrame`: a polyfill, a jest/vitest timer
   * shim, or any harness that runs the callback inline. `limit` stops the
   * self-rescheduling loop from recursing forever.
   */
  function installSyncRaf(limit: number): { calls: () => number } {
    let calls = 0;

    globalThis.requestAnimationFrame = ((cb: (timer: number) => void): number => {
      calls += 1;
      const id = calls;
      if (calls <= limit) cb(id * 16);
      return id;
    }) as typeof globalThis.requestAnimationFrame;

    return { calls: () => calls };
  }

  test('a synchronous requestAnimationFrame does not throw ReferenceError', () => {
    const { render } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });
    installSyncRaf(3);

    // Reverted fix: `loop` reads `id` while `let id = requestAnimationFrame(
    // loop)` is still evaluating its initialiser →
    // `ReferenceError: Cannot access 'id' before initialization`.
    expect(() => {
      render.start();
    }).not.toThrow();

    // One frame per request now (R8): `start()` draws one and parks, and each
    // `requestFrame()` recurses straight back into the loop through the
    // synchronous rAF — which is the shape that used to hit the TDZ.
    expect(render.frameDraws).toBe(1);

    render.wake();
    render.wake();
    expect(render.frameDraws).toBe(3);
  });

  test('a frame queued by a stopped loop is dropped', () => {
    // The subtly wrong variant: deleting the identity check altogether, which
    // is the obvious way to make the TDZ go away. Without it a callback that
    // was already queued when `stop()` ran still renders — and, worse,
    // reschedules itself, so the loop is unkillable.
    const { render } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });

    let queued: ((timer: number) => void) | null = null;
    globalThis.requestAnimationFrame = ((cb: (timer: number) => void): number => {
      queued = cb;
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    // A browser that has already dispatched the callback cannot cancel it, and
    // `cancelAnimationFrame` may not exist at all (R3). The guard, not the
    // cancel, is what must hold.
    globalThis.cancelAnimationFrame = (() => undefined) as typeof globalThis.cancelAnimationFrame;

    render.start();
    const inFlight = queued as unknown as (timer: number) => void;
    render.stop();

    inFlight(16);
    expect(render.frameDraws).toBe(0);

    // …and it did not reschedule itself either.
    inFlight(32);
    expect(render.frameDraws).toBe(0);
  });

  test('restarting supersedes the previous loop instead of doubling it', () => {
    // Same variant, other symptom: two live loops both calling `drawFrame`,
    // which is how a book ends up rendering twice per frame after a resize.
    const { render } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });

    const queued: Array<(timer: number) => void> = [];
    globalThis.requestAnimationFrame = ((cb: (timer: number) => void): number => {
      queued.push(cb);
      return queued.length;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof globalThis.cancelAnimationFrame;

    render.start();
    const first = queued[0];
    render.start();
    const second = queued[1];

    if (first === undefined || second === undefined) throw new Error('no frame scheduled');

    first(16);
    second(16);

    expect(render.frameDraws).toBe(1);
  });

  test('the ordinary asynchronous loop is unchanged', () => {
    const { render, tick } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });

    // R8: "unchanged" is now per requested frame — the generation guard must
    // not eat a frame that WAS asked for. Each `requestFrame()` re-arms the
    // parked loop exactly once, and every tick draws.
    render.start();
    tick(16);
    render.wake();
    tick(32);
    render.wake();
    tick(48);

    expect(render.frameDraws).toBe(3);
  });
});

describe('U5 — startAnimation must not orphan a turn chained from its own commit', () => {
  /** Five frames, tagged, so three animations can share one trace. */
  function tagged(trace: string[], tag: string): Array<() => void> {
    return [0, 1, 2, 3, 4].map((i) => () => trace.push(`${tag}:${String(i)}`));
  }

  test('an animation installed by the opening finishAnimation() survives', () => {
    // The live race: turn A is animating, its `onAnimateEnd` chains B (a
    // consumer calling `flipNext()` from `onFlip`, auto-advance, a controlled
    // `page` prop) — and a user gesture starts C at the same moment. C's own
    // `finishAnimation()` is what commits A and therefore what creates B.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(tagged(trace, 'A'), 500, () => {
      trace.push('A:end');
      render.startAnimation(tagged(trace, 'B'), 500, () => trace.push('B:end'));
    });

    tick(1100); // A binds here and plays frame 0

    // The racing gesture. Reverted fix: `this.animation = {...}` at the bottom
    // of `startAnimation` replaces B with C, and B's `onAnimateEnd` — the
    // callback that COMMITS the chained page turn — never runs.
    render.startAnimation(tagged(trace, 'C'), 500, () => trace.push('C:end'));

    expect(trace).toEqual(['A:0', 'A:4', 'A:end']);

    tick(1200);
    tick(1300);

    // B is the animation on the object, playing from the frame clock it was
    // stamped on (R2), and C never ran at all.
    expect(trace).toEqual(['A:0', 'A:4', 'A:end', 'B:1', 'B:2']);

    tick(1700);
    expect(trace).toContain('B:end');
    expect(trace.filter((entry) => entry.startsWith('C:'))).toEqual([]);
  });

  test('a chained INSTANT turn is not overrun by the outer request', () => {
    // The subtly wrong variant this catches: guarding with `if (this.animation
    // === null)` instead of a generation counter. That is the obvious fix and it
    // handles the test above — but a nested INSTANT turn (`flippingTime: 0`,
    // `prefers-reduced-motion`) installs NOTHING: it runs its final frame and
    // its callback synchronously and leaves the field null. The outer call then
    // installs C over a book that has already committed the chained turn, and
    // C's `onAnimateEnd` commits a SECOND page turn on top of it.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(tagged(trace, 'A'), 500, () => {
      trace.push('A:end');
      render.startAnimation(tagged(trace, 'B'), 0, () => trace.push('B:end'));
    });

    tick(1100);
    render.startAnimation(tagged(trace, 'C'), 500, () => trace.push('C:end'));

    expect(trace).toEqual(['A:0', 'A:4', 'A:end', 'B:4', 'B:end']);

    // Forced frames (R8 parks the loop once the instant turn has committed) —
    // and they must draw nothing, which is the assertion below.
    tick(1200);
    render.wake();
    tick(1300);
    render.wake();
    tick(1700);

    // Nothing further ran: no C frames, and above all no second commit.
    expect(trace).toEqual(['A:0', 'A:4', 'A:end', 'B:4', 'B:end']);
  });

  test('a turn abandoned from the commit is not resurrected by the outer request', () => {
    // Same slot, the teardown path: a consumer calling `replacePages()` /
    // `destroy()` from `onFlip` reaches `cancelAnimation()`, whose whole purpose
    // is to drop the turn WITHOUT committing it. The outer `startAnimation` must
    // not then install an animation over pages that were just released.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(tagged(trace, 'A'), 500, () => {
      trace.push('A:end');
      render.cancelAnimation();
    });

    tick(1100);
    render.startAnimation(tagged(trace, 'C'), 500, () => trace.push('C:end'));

    tick(1200);
    render.wake();
    tick(1300);

    expect(trace).toEqual(['A:0', 'A:4', 'A:end']);
  });

  test('the ordinary path still replaces a running animation', () => {
    // The guard must not become "first animation wins". With nothing chained
    // from the commit, a new `startAnimation` supersedes the old one exactly as
    // before — that is how every gesture that interrupts a turn works.
    const { render, tick } = makeHarness();
    const trace: string[] = [];

    render.start();
    render.startAnimation(tagged(trace, 'A'), 500, () => trace.push('A:end'));

    tick(1100);
    render.startAnimation(tagged(trace, 'B'), 500, () => trace.push('B:end'));

    // A was committed by B's opening `finishAnimation()`…
    expect(trace).toEqual(['A:0', 'A:4', 'A:end']);

    // …and B is the animation now running.
    tick(1200);
    tick(1700);
    expect(trace).toContain('B:1');
    expect(trace).toContain('B:end');
  });
});

/* ------------------------------------------------------------------------- *
 * R8 — the loop parks when there is nothing to draw.
 *
 * C1: `loop` re-armed unconditionally, so `drawFrame()` ran ~60 times a second
 * for the life of the page on a book nobody had touched — in HTML mode as much
 * as canvas. The rule here is deliberately asymmetric: parking is an
 * optimisation and waking is a correctness requirement, so every mutator wakes
 * the loop even where it might not have needed to, and the park decision is
 * taken only after a frame has been drawn.
 * ------------------------------------------------------------------------- */

describe('R8 — an idle loop parks', () => {
  test('an untouched book draws one frame and then asks for nothing', () => {
    const { render, tick, pending } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });

    render.start();
    tick(0);

    // Reverted fix: `pending()` is true forever and `drawFrame` runs on every
    // rAF of the page's life.
    expect(render.frameDraws).toBe(1);
    expect(pending()).toBe(false);
  });

  test('requestFrame wakes it for exactly one frame', () => {
    const { render, tick, pending } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });

    render.start();
    tick(0);
    expect(pending()).toBe(false);

    render.wake();
    expect(pending()).toBe(true);
    tick(16);

    expect(render.frameDraws).toBe(2);
    expect(pending()).toBe(false);
  });

  test('an animation keeps it awake for every one of its frames', () => {
    // The park must never cut a turn short: five frames plus the commit frame.
    const { render, tick, pending } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });
    const trace: string[] = [];

    render.start();
    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));

    for (const t of [0, 100, 200, 300, 400, 500]) {
      expect(pending()).toBe(true);
      tick(t);
    }

    expect(trace).toEqual(['frame:0', 'frame:1', 'frame:2', 'frame:3', 'frame:4', 'end']);
    expect(render.frameDraws).toBe(6);
    expect(pending()).toBe(false);
  });

  test('a turn started after a long park is not stamped with the parked clock', () => {
    // The subtly wrong variant: parking without clearing the frame clock. It
    // is R5 again, and parking makes it the COMMON case rather than a one-frame
    // window — a book sits idle for a minute, the reader turns a page, and the
    // stale stamp makes the very first resumed frame overshoot the whole list,
    // so the turn plays instantly with no animation at all.
    const { render, tick } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });
    const trace: string[] = [];

    render.start();
    tick(1000); // draws, then parks

    render.startAnimation(fiveFrames(trace), 500, () => trace.push('end'));
    tick(61_000); // a minute later

    // Reverted (`park()` without `this.timer = null`): ['frame:4', 'end'].
    expect(trace).toEqual(['frame:0']);
  });

  test('a stopped loop is not resurrected by a late frame request', () => {
    // `destroy()` calls `stop()`. A consumer holding the render — a pending
    // effect, an async callback — must not be able to restart a torn-down
    // engine, which is what separates a park from a stop.
    const { render, tick, pending } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });

    render.start();
    tick(0);
    render.stop();

    render.wake();

    expect(pending()).toBe(false);
    expect(render.frameDraws).toBe(1);
  });

  test('a parked loop resumes under a SYNCHRONOUS requestAnimationFrame', () => {
    // R7's environment, and the trap this design walked into once: with a
    // synchronous rAF the callback runs — and parks — before
    // `requestAnimationFrame` returns, so the id it returns is assigned to
    // `rafId` AFTER the park. A scheduler that asked `rafId !== 0` would then
    // believe a frame was pending forever and never draw again. That is a book
    // that stops and never restarts: strictly worse than the defect R8 fixes.
    const { render } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });

    let calls = 0;
    globalThis.requestAnimationFrame = ((cb: (timer: number) => void): number => {
      calls += 1;
      const id = calls;
      cb(id * 16);
      return id;
    }) as typeof globalThis.requestAnimationFrame;

    render.start();
    expect(render.frameDraws).toBe(1);

    render.wake();
    render.wake();

    expect(render.frameDraws).toBe(3);
  });
});

describe('R8 — every renderer mutator wakes the loop', () => {
  /**
   * One case per way renderer state can change, because "the loop parks" is
   * only safe if this list is exhaustive. Each entry is what some caller does:
   * `Flip.do` (page rect, shadow, mover), `Flip.start` (direction),
   * `PageCollection.showSpread` (static leaves), `PageFlip.update` /
   * `UI.onResize` (update), `Flip.animateFlippingTo` (startAnimation),
   * `PageFlip.replacePages` (cancelAnimation), `UI.unfoldHoverCorner`
   * (finishAnimation), `PageFlip.destroy` / `clear` (releasePages).
   *
   * These assert the PROPERTY ("this input wakes a parked loop"), not a
   * particular line: some are provided twice over — `startAnimation` opens with
   * `finishAnimation()`, and `releasePages` delegates to `cancelAnimation` — so
   * removing one `requestFrame()` call may leave its own case green while
   * another entry catches it. The list is exhaustive by construction instead:
   * one entry per public mutator on `Render`.
   */
  const mutators: Array<[string, (render: Render) => void]> = [
    ['update', (r) => r.update()],
    ['setLeftPage', (r) => r.setLeftPage(null)],
    ['setRightPage', (r) => r.setRightPage(null)],
    ['setBottomPage', (r) => r.setBottomPage(null)],
    ['setFlippingPage', (r) => r.setFlippingPage(null)],
    [
      'setPageRect',
      (r) =>
        r.setPageRect({
          topLeft: { x: 0, y: 0 },
          topRight: { x: 1, y: 0 },
          bottomLeft: { x: 0, y: 1 },
          bottomRight: { x: 1, y: 1 },
        }),
    ],
    ['setShadowData', (r) => r.setShadowData({ x: 1, y: 1 }, 0.5, 50, FlipDirection.FORWARD)],
    ['clearShadow', (r) => r.clearShadow()],
    ['setDirection', (r) => r.setDirection(FlipDirection.BACK)],
    ['cancelAnimation', (r) => r.cancelAnimation()],
    ['finishAnimation', (r) => r.finishAnimation()],
    ['releasePages', (r) => r.releasePages()],
    ['startAnimation', (r) => r.startAnimation([() => undefined], 100, () => undefined)],
  ];

  for (const [name, mutate] of mutators) {
    test(`${name} re-arms a parked loop`, () => {
      const { render, tick, pending } = makeHarness({}, { offsetWidth: 400, offsetHeight: 300 });

      render.start();
      tick(0);

      // FIXTURE CHECK: asserting that a frame was scheduled is worthless if one
      // was scheduled already.
      expect(pending()).toBe(false);

      mutate(render);

      expect(pending()).toBe(true);
    });
  }
});
