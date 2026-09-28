import { expect, test, type Page } from '@playwright/test';
import { engineSnapshot } from './engine-access';

/**
 * §8.3 Gesture e2e — real touch, swipe thresholds, tap zones, drag-release mid-curl.
 *
 * Unit tests cannot honestly simulate stopMove re-entry after a mid-curl release;
 * these drive the live pointer path on the vanilla example.
 *
 * stopMove complete/cancel uses FlipCalculation position: local x <= 0 finishes
 * the turn. In portrait that is the finger at or past the left edge of the
 * visible page (render bounds are a 2-page-wide rect with left = -pageWidth).
 */

/** Portrait phone-ish viewport so the book is single-page. */
const PORTRAIT = { width: 420, height: 800 };

/** Match UI.ts defaults: swipeDistance 30, swipeTimeout 250ms. */
const DEFAULT_SWIPE_DISTANCE = 30;

test.use({
  hasTouch: true,
  viewport: PORTRAIT,
});

type Pt = { x: number; y: number };

async function openBook(page: Page, query = '') {
  await page.setViewportSize(PORTRAIT);
  // Instant turns so post-gesture assertions are not racing the rAF animation.
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  if (!params.has('flippingTime')) params.set('flippingTime', '0');
  await page.goto(`/?${params.toString()}`);
  await expect(page.locator('body[data-ready="1"]')).toBeAttached();
  await expect(page.locator('#book .stf__block')).toBeVisible();
}

function settle(page: Page) {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function bookBox(page: Page) {
  const box = await page.locator('#book .stf__block').boundingBox();
  if (!box) throw new Error('no book box');
  return box;
}

/** Live engine snapshot — state, page index, fold calc position.
 * Implementation: `./engine-access` (symbol-keyed flip after C7).
 */

function bookSettings(page: Page) {
  return page.evaluate(() => {
    const book = (
      window as unknown as {
        flipbook: {
          getSettings(): {
            swipeDistance: number;
            flipOnClick: string;
            flippingTime: number;
          };
        };
      }
    ).flipbook;
    const s = book.getSettings();
    return {
      swipeDistance: s.swipeDistance,
      flipOnClick: s.flipOnClick,
      flippingTime: s.flippingTime,
    };
  });
}

async function visibleLeafCount(page: Page) {
  return page.$$eval(
    '#book .stf__item',
    (nodes) =>
      nodes.filter((node) => {
        const el = node as HTMLElement;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && rect.width > 0;
      }).length,
  );
}

/**
 * Fire a single touch-pointer event on the book block.
 * pointerType: 'touch' hits the allowTouchScroll branch in UI.ts.
 */
async function touchPointer(
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  pt: Pt,
) {
  await page.evaluate(
    ({ type, x, y }) => {
      const book = document.querySelector('#book .stf__block');
      if (!book) throw new Error('missing .stf__block');
      const buttons = type === 'pointerup' || type === 'pointercancel' ? 0 : 1;
      book.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons,
          view: window,
        }),
      );
    },
    { type, x: pt.x, y: pt.y },
  );
}

/**
 * Fast touch swipe in one evaluate so wall time stays under UI's 250ms swipeTimeout.
 * Engine swipe: |dx| > swipeDistance, |dy| < swipeDistance*2, dt < 250ms.
 */
async function touchSwipeFast(page: Page, from: Pt, to: Pt, steps = 6) {
  await page.evaluate(
    ({ from, to, steps }) => {
      const book = document.querySelector('#book .stf__block');
      if (!book) throw new Error('missing .stf__block');

      const fire = (type: string, x: number, y: number, buttons: number) => {
        book.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 1,
            pointerType: 'touch',
            isPrimary: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons,
            view: window,
          }),
        );
      };

      fire('pointerdown', from.x, from.y, 1);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        fire('pointermove', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 1);
      }
      fire('pointerup', to.x, to.y, 0);
    },
    { from, to, steps },
  );
}

/**
 * Slow touch drag with paints between moves — wall clock must exceed UI's
 * 250ms swipeTimeout so release goes through stopMove (USER_FOLD path), not
 * the swipe shortcut that would flipNext regardless of fold position.
 */
async function touchDragSlow(page: Page, from: Pt, to: Pt, steps = 8) {
  await touchPointer(page, 'pointerdown', from);
  // Guarantee dt > swipeTimeout even on a fast machine / few steps.
  await page.waitForTimeout(300);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await touchPointer(page, 'pointermove', {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    });
    await settle(page);
  }
}

test.describe('real touch', () => {
  test('touchscreen.tap on the forward edge turns the page', async ({ page }) => {
    await openBook(page);
    const box = await bookBox(page);

    // Playwright's real touch path (requires hasTouch: true).
    await page.touchscreen.tap(box.x + box.width - 16, box.y + 24);
    await expect(page.locator('body[data-page="1"]')).toBeAttached();

    const snap = await engineSnapshot(page);
    expect(snap.state).toBe('read');
    expect(snap.folding).toBe(false);
  });
});

test.describe('swipe thresholds', () => {
  test('a long horizontal swipe completes a forward turn', async ({ page }) => {
    await openBook(page);
    const box = await bookBox(page);
    const midY = box.y + box.height / 2;
    // Start on the page (not past the edge), swipe left past swipeDistance.
    const from = { x: box.x + box.width * 0.75, y: midY };
    const to = { x: from.x - (DEFAULT_SWIPE_DISTANCE + 50), y: midY };

    await touchSwipeFast(page, from, to);
    await expect(page.locator('body[data-page="1"]')).toBeAttached();

    const snap = await engineSnapshot(page);
    expect(snap.state).toBe('read');
    expect(snap.page).toBe(1);
    expect(await visibleLeafCount(page)).toBeGreaterThan(0);
  });

  test('a short swipe below swipeDistance does not turn the page', async ({ page }) => {
    // Raise the threshold so a deliberate small drag is clearly under it.
    await openBook(page, '?swipeDistance=80');
    expect((await bookSettings(page)).swipeDistance).toBe(80);

    const box = await bookBox(page);
    const midY = box.y + box.height / 2;
    const from = { x: box.x + box.width * 0.7, y: midY };
    // Move enough to count as a user move (>10px touch / >5px fold) but under 80.
    const to = { x: from.x - 40, y: midY };

    await touchSwipeFast(page, from, to);
    await settle(page);

    const snap = await engineSnapshot(page);
    expect(snap.page).toBe(0);
    expect(snap.state).toBe('read');
    expect(snap.folding).toBe(false);
  });

  test('a long swipe turns backward from page 1', async ({ page }) => {
    await openBook(page);
    const box = await bookBox(page);
    const midY = box.y + box.height / 2;

    await page.touchscreen.tap(box.x + box.width - 16, box.y + 24);
    await expect(page.locator('body[data-page="1"]')).toBeAttached();

    // Swipe right → prev in LTR.
    const from = { x: box.x + box.width * 0.3, y: midY };
    const to = { x: from.x + (DEFAULT_SWIPE_DISTANCE + 50), y: midY };
    await touchSwipeFast(page, from, to);
    await expect(page.locator('body[data-page="0"]')).toBeAttached();

    const snap = await engineSnapshot(page);
    expect(snap.state).toBe('read');
  });

  test('a reverse swipe at page zero does not strand an interrupted forward turn', async ({
    page,
  }) => {
    await openBook(page, '?flippingTime=800&reducedMotion=0');
    const box = await bookBox(page);
    const midY = box.y + box.height / 2;
    const forward = { x: box.x + box.width * 0.75, y: midY };
    // The block's own box is the visible portrait leaf. Stay inside its BACK
    // band for the whole swipe, including the last pointermove.
    const backward = { x: box.x + 20, y: midY };

    await touchSwipeFast(page, forward, { x: forward.x - 80, y: midY });
    expect((await engineSnapshot(page)).state).toBe('flipping');

    await touchSwipeFast(page, backward, { x: backward.x + DEFAULT_SWIPE_DISTANCE + 10, y: midY });
    const snap = await engineSnapshot(page);
    expect(snap.page).toBe(0);
    expect(snap.state).toBe('read');
    expect(snap.folding).toBe(false);
    expect(await visibleLeafCount(page)).toBeGreaterThan(0);
  });

  test('a boundary swipe that crosses the fold-direction band settles its drag', async ({
    page,
  }) => {
    await openBook(page, '?flippingTime=800&reducedMotion=0');
    const box = await bookBox(page);
    const midY = box.y + box.height / 2;
    const from = { x: box.x + box.width * 0.3, y: midY };

    // The fold becomes FORWARD after crossing its split, but the whole swipe
    // is rightward and requests BACK. Page zero refuses that semantic turn.
    await touchSwipeFast(page, from, { x: from.x + 80, y: midY });
    const snap = await engineSnapshot(page);
    expect(snap.page).toBe(0);
    expect(snap.state).toBe('read');
    expect(snap.folding).toBe(false);
    await expect(page.locator('#book [data-stf-clone]')).toHaveCount(0);
  });
});

test.describe('tap zones', () => {
  test('edge tap turns forward when flip-by-click is enabled', async ({ page }) => {
    await openBook(page);
    const box = await bookBox(page);

    await page.touchscreen.tap(box.x + box.width - 12, box.y + box.height / 2);
    await expect(page.locator('body[data-page="1"]')).toBeAttached();
  });

  test('corner tap turns when flipOnClick is corners', async ({ page }) => {
    await openBook(page, '?disableFlipByClick=1');
    expect((await bookSettings(page)).flipOnClick).toBe('corners');

    const box = await bookBox(page);

    // Center of the visible page — outside isPointOnCorners operating distance.
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await settle(page);
    expect((await engineSnapshot(page)).page).toBe(0);

    // Top-right corner is inside isPointOnCorners.
    await page.touchscreen.tap(box.x + box.width - 8, box.y + 8);
    await expect(page.locator('body[data-page="1"]')).toBeAttached();

    const snap = await engineSnapshot(page);
    expect(snap.state).toBe('read');
  });
});

test.describe('drag-release mid-curl', () => {
  test('fold engages during a touch drag and cancel-release snaps back', async ({ page }) => {
    await openBook(page);
    const box = await bookBox(page);
    const midY = box.y + box.height / 2;
    const from = { x: box.x + box.width - 14, y: midY };
    // Still well inside the page — local fold x stays > 0 → stopMove cancels.
    const mid = { x: box.x + box.width * 0.55, y: midY };

    await touchDragSlow(page, from, mid, 6);

    const midSnap = await engineSnapshot(page);
    expect(midSnap.state).toBe('user_fold');
    expect(midSnap.folding).toBe(true);
    expect(midSnap.foldX).not.toBeNull();
    expect(midSnap.foldX as number).toBeGreaterThan(0);
    expect(midSnap.page).toBe(0);

    await touchPointer(page, 'pointerup', mid);
    await settle(page);

    const end = await engineSnapshot(page);
    expect(end.state).toBe('read');
    expect(end.folding).toBe(false);
    expect(end.page).toBe(0);
    expect(await visibleLeafCount(page)).toBeGreaterThan(0);
  });

  test('releasing past the left edge completes the turn without a stuck fold', async ({ page }) => {
    await openBook(page);
    const box = await bookBox(page);
    const midY = box.y + box.height / 2;
    const from = { x: box.x + box.width - 14, y: midY };
    // stopMove finishes when local x <= 0 = finger at/past the left edge.
    const past = { x: box.x - 80, y: midY };

    await touchDragSlow(page, from, past, 12);

    const midSnap = await engineSnapshot(page);
    expect(midSnap.state).toBe('user_fold');
    expect(midSnap.folding).toBe(true);
    expect(midSnap.foldX).not.toBeNull();
    expect(midSnap.foldX as number).toBeLessThanOrEqual(0);

    await touchPointer(page, 'pointerup', past);
    await settle(page);
    await expect(page.locator('body[data-page="1"]')).toBeAttached();

    const end = await engineSnapshot(page);
    expect(end.state).toBe('read');
    expect(end.folding).toBe(false);
    expect(end.page).toBe(1);
    expect(await visibleLeafCount(page)).toBeGreaterThan(0);
  });

  test('release does not double-turn or leave USER_FOLD after a cancel', async ({ page }) => {
    await openBook(page);
    const box = await bookBox(page);
    const midY = box.y + box.height / 2;
    const from = { x: box.x + box.width - 14, y: midY };
    const slight = { x: box.x + box.width * 0.7, y: midY };

    await touchDragSlow(page, from, slight, 5);
    expect((await engineSnapshot(page)).state).toBe('user_fold');
    expect((await engineSnapshot(page)).foldX as number).toBeGreaterThan(0);

    await touchPointer(page, 'pointerup', slight);
    await settle(page);
    // pointerleave after release must not re-enter stopMove (UI activePointerId guard).
    await page.locator('#book .stf__block').dispatchEvent('pointerleave');
    await settle(page);

    const end = await engineSnapshot(page);
    expect(end.state).toBe('read');
    expect(end.folding).toBe(false);
    expect(end.page).toBe(0);

    // A second independent turn still works — book is not blank or wedged.
    await page.touchscreen.tap(box.x + box.width - 12, box.y + 20);
    await expect(page.locator('body[data-page="1"]')).toBeAttached();
    expect((await engineSnapshot(page)).state).toBe('read');
  });
});
