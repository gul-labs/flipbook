import { expect, test, type Page } from '@playwright/test';
import { foldProgress, settleAtPage } from './engine-access';

/**
 * §8.2 Golden visual frames.
 *
 * Unit tests and the invariant suite can pass while the live curl is still a
 * slide-in or a translucent fold. These screenshots are the guard for §4.1
 * (portrait back-curl) and §4.2 (opaque fold): mid-flip frames at 25 / 50 /
 * 75 % of the turn path, for portrait × landscape × forward × back, plus a
 * hard-cover turn.
 *
 * Timing strategy: hold a real pointer drag (same path the invariant suite
 * uses) to 25 / 50 / 75 % of the distance across the book, then screenshot
 * while the button is still down. Pointer fraction is a stable stand-in for
 * “% of flippingTime” without racing a free-running `flip()` animation.
 *
 * Capture uses a **padded clip around `#book`**: portrait BACK paints the curl
 * outside the leaf’s border box, so an element screenshot of `#book` alone
 * green-passes a blank white rectangle.
 */

const FLIPPING_TIME_MS = 1000;
const PATH_FRACTIONS = [0.25, 0.5, 0.75] as const;
/** Padding around `#book` so out-of-box curl stays in frame. */
const SHOT_PAD = 72;

const PORTRAIT = { width: 520, height: 800 };
const LANDSCAPE = { width: 1200, height: 800 };

/**
 * Soft threshold: subpixel / antialias / shadow-gradient variance across GPU
 * paths. A slide-in vs curl or a translucent fold moves far more than 5%.
 */
const SCREENSHOT = {
  maxDiffPixelRatio: 0.05,
  timeout: 10_000,
};

type FlipDir = 'forward' | 'back';

function goldenQuery(extra = ''): string {
  const base = `golden=1&flippingTime=${FLIPPING_TIME_MS}&reducedMotion=0`;
  return extra ? `?${base}&${extra}` : `?${base}`;
}

async function openBook(
  page: Page,
  size: { width: number; height: number },
  queryExtra = '',
): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`/${goldenQuery(queryExtra)}`);
  await expect(page.locator('body[data-ready="1"]')).toBeAttached();
  await expect(page.locator('#book .stf__block')).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function paint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function settleAt(page: Page, pageIndex: number): Promise<void> {
  // C7: render is symbol-keyed — see `./engine-access`.
  await settleAtPage(page, pageIndex);
  await paint(page);
}

/** Padded page clip so folds that leave the leaf box are still visible. */
async function shotClip(page: Page) {
  const box = await page.locator('#book').boundingBox();
  if (!box) throw new Error('no #book box');
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport');
  const x = Math.max(0, Math.floor(box.x - SHOT_PAD));
  const y = Math.max(0, Math.floor(box.y - SHOT_PAD));
  const width = Math.min(viewport.width - x, Math.ceil(box.width + SHOT_PAD * 2));
  const height = Math.min(viewport.height - y, Math.ceil(box.height + SHOT_PAD * 2));
  return { x, y, width, height };
}

/**
 * Drag to a fixed fraction of the turn path and screenshot while held.
 *
 * Forward peels from the right edge leftward; back peels from the left edge
 * rightward — the same geometry the §4.1 invariant suite exercises.
 */
async function capturePathFrame(
  page: Page,
  direction: FlipDir,
  startPage: number,
  fraction: number,
  snapshotName: string,
): Promise<void> {
  await settleAt(page, startPage);

  const box = await page.locator('#book .stf__block').boundingBox();
  if (!box) throw new Error('no book box');

  // Vertical mid matches the invariant suite’s drag; fold engages reliably.
  const y = box.y + box.height / 2;
  const fromX = direction === 'forward' ? box.x + box.width - 12 : box.x + 12;
  const toX = direction === 'forward' ? box.x + box.width * 0.1 : box.x + box.width * 0.9;
  const targetX = fromX + (toX - fromX) * fraction;

  await page.mouse.move(fromX, y);
  await page.mouse.down();
  await page.mouse.move(targetX, y, { steps: 20 });
  await paint(page);

  // Fold must be live: a zero-progress frame would green-pass a broken curl.
  // C7: flip controller is symbol-keyed — see `./engine-access`.
  const progress = await foldProgress(page);
  expect(progress, `fold engaged for ${snapshotName}`).not.toBeNull();
  expect(progress ?? 0, `fold progress for ${snapshotName}`).toBeGreaterThan(1);

  const clip = await shotClip(page);
  await expect(page).toHaveScreenshot(snapshotName, { ...SCREENSHOT, clip });

  await page.mouse.up();
  await paint(page);
}

async function captureFlipSeries(
  page: Page,
  direction: FlipDir,
  startPage: number,
  namePrefix: string,
): Promise<void> {
  for (const fraction of PATH_FRACTIONS) {
    const pct = Math.round(fraction * 100);
    await capturePathFrame(page, direction, startPage, fraction, `${namePrefix}-${pct}pct.png`);
  }
  await settleAt(page, startPage);
}

test.describe('golden mid-flip frames (§8.2)', () => {
  test.describe('portrait', () => {
    test('forward 25/50/75', async ({ page }) => {
      await openBook(page, PORTRAIT);
      expect(await page.locator('body').getAttribute('data-orientation')).toBe('portrait');
      await captureFlipSeries(page, 'forward', 0, 'portrait-forward');
    });

    test('back 25/50/75', async ({ page }) => {
      await openBook(page, PORTRAIT);
      // Need a previous leaf so BACK peels the current page (the §4.1 case).
      await settleAt(page, 1);
      await captureFlipSeries(page, 'back', 1, 'portrait-back');
    });
  });

  test.describe('landscape', () => {
    test('forward 25/50/75', async ({ page }) => {
      await openBook(page, LANDSCAPE);
      expect(await page.locator('body').getAttribute('data-orientation')).toBe('landscape');
      await captureFlipSeries(page, 'forward', 0, 'landscape-forward');
    });

    test('back 25/50/75', async ({ page }) => {
      await openBook(page, LANDSCAPE);
      // Landscape spreads are [0,1] then [2,3]; page 2 is the second spread.
      await settleAt(page, 2);
      await captureFlipSeries(page, 'back', 2, 'landscape-back');
    });
  });

  test.describe('hard cover', () => {
    test('cover open 25/50/75', async ({ page }) => {
      await openBook(page, LANDSCAPE, 'cover=1');
      expect(await page.locator('body').getAttribute('data-orientation')).toBe('landscape');
      // showCover: first leaf is a single-page spread; flipping it is the hard turn.
      await captureFlipSeries(page, 'forward', 0, 'hardcover-forward');
    });
  });

  /**
   * Frame-discipline B2 — single mid-fold frames held under the pointer. Regression
   * net for Campaign B3 frame-discipline opts; must stay pixel-stable.
   */
  test.describe('mid-fold held (B2)', () => {
    test('landscape forward ~40%', async ({ page }) => {
      await openBook(page, LANDSCAPE);
      expect(await page.locator('body').getAttribute('data-orientation')).toBe('landscape');
      await capturePathFrame(page, 'forward', 0, 0.4, 'mid-fold-landscape-forward.png');
    });

    test('portrait back mid-fold', async ({ page }) => {
      await openBook(page, PORTRAIT);
      expect(await page.locator('body').getAttribute('data-orientation')).toBe('portrait');
      // Need a previous leaf so BACK peels the current page (the §4.1 case).
      await settleAt(page, 1);
      await capturePathFrame(page, 'back', 1, 0.5, 'mid-fold-portrait-back.png');
    });
  });
});
