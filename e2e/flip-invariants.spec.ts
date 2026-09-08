import { expect, test, type Page } from '@playwright/test';
import { foldX } from './engine-access';

/**
 * The §4.1 / §4.2 guard.
 *
 * Screenshots were the original plan, but committed pixels are a poor bargain
 * here: they are platform-specific, they go stale on any cosmetic change, and
 * they cannot say *why* a frame is wrong. These read the same invariants
 * straight off the live engine instead, which is what the unit tests cannot do
 * — they passed downstream while the browser still showed the slide-in.
 */

const PORTRAIT = { width: 420, height: 800 };
const LANDSCAPE = { width: 1100, height: 700 };

async function openBook(page: Page, size: { width: number; height: number }, query = '') {
  await page.setViewportSize(size);
  await page.goto(`/${query}`);
  await expect(page.locator('body[data-ready="1"]')).toBeAttached();
  await expect(page.locator('#book .stf__block')).toBeVisible();

  // Leaves get their visibility and position from `drawFrame`, which runs on
  // rAF — `data-ready` only says the engine was constructed. Reading the DOM
  // before the first frame saw 1 leaf instead of 2 under parallel load, which
  // is a flaky test, not a flaky engine.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

function orientation(page: Page) {
  return page.locator('body').getAttribute('data-orientation');
}

/** Geometry of every mounted leaf, in DOM order. */
async function leaves(page: Page) {
  return page.$$eval('#book .stf__item', (nodes) =>
    nodes.map((node) => {
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      // The leaf is positioned by `transform`, and clipped by `clip-path`; the
      // bounding box does not move, so read the translation itself.
      // B3: paper is structural — the leaf root's own background-color may be
      // transparent; the opaque base is the `::before` layer (`--stf-paper`
      // composited over #fff).
      const paper = getComputedStyle(el, '::before');
      return {
        text: (el.textContent ?? '').trim(),
        display: style.display,
        background: style.backgroundColor,
        paperBackground: paper.backgroundColor,
        clipped: style.clipPath !== 'none',
        // The leaf being animated is the only one carrying a transform.
        moving: style.transform !== 'none',
        x: Math.round(rect.x),
        width: Math.round(rect.width),
        // B3: show/hide moved from `display` to the visibility axis.
        visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0,
      };
    }),
  );
}

async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await settle(page);
}

/** Let the render loop paint what the engine just calculated. */
function settle(page: Page) {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Where the fold currently sits, in on-screen coordinates.
 *
 * Read from the engine rather than from a bounding box: the leaf is drawn with
 * a clip-path over a transformed element, and Chromium and WebKit disagree on
 * what rectangle that produces even when the fold is in the same place.
 * Implementation: `./engine-access` (symbol-keyed render/flip after C7).
 */

test.describe('portrait back-curl (StPageFlip #49)', () => {
  test('the moving leaf is a copy of the current page, and the previous leaf is painted under it', async ({
    page,
  }) => {
    await openBook(page, PORTRAIT);
    expect(await orientation(page)).toBe('portrait');

    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');

    // Forward once so a backward turn is possible. Drive the engine, not a
    // corner click: WebKit CI missed the 20px inset click while Chromium did
    // not, and this test is about the BACK clone, not click targeting.
    await page.evaluate(() => {
      (window as unknown as { flipbook: { flipNext(): boolean } }).flipbook.flipNext();
    });
    await expect(page.locator('body[data-page="1"]')).toBeAttached({ timeout: 10_000 });

    const mid = box.y + box.height / 2;
    await dragTo(page, { x: box.x + 12, y: mid }, { x: box.x + box.width * 0.8, y: mid });

    const mounted = await leaves(page);
    const visible = mounted.filter((leaf) => leaf.visible);

    // Upstream animates `pages[current - 1]` and skips the leaf underneath, so
    // exactly one leaf moves and the page below it never paints. The fix
    // animates a *copy* of the current leaf, so the current page's text is
    // mounted twice while the previous leaf paints underneath.
    const currentCopies = visible.filter((leaf) => leaf.text === 'Two');
    expect(currentCopies.length).toBe(2);
    expect(visible.some((leaf) => leaf.text === 'One')).toBe(true);

    await page.mouse.up();
  });

  test('the turning leaf is opaque', async ({ page }) => {
    await openBook(page, PORTRAIT);

    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');

    const mid = box.y + box.height / 2;
    await dragTo(
      page,
      { x: box.x + box.width - 12, y: mid },
      { x: box.x + box.width * 0.35, y: mid },
    );

    const moving = (await leaves(page)).filter((leaf) => leaf.visible);
    expect(moving.length).toBeGreaterThan(1);

    // A transparent fold is §4.2: the page underneath reads through the leaf.
    // B3: opacity is structural — the root's own background-color may be
    // transparent, but every leaf's `::before` paper layer must paint opaque.
    for (const leaf of moving) {
      expect(leaf.paperBackground).not.toBe('rgba(0, 0, 0, 0)');
      expect(leaf.paperBackground).not.toBe('transparent');
    }

    await page.mouse.up();
  });

  test('the curl travels rightward across the drag', async ({ page }) => {
    await openBook(page, PORTRAIT);

    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');

    // Forward once so there is a previous leaf to curl back to.
    await page.mouse.click(box.x + box.width - 20, box.y + 20);
    await expect(page.locator('body[data-page="1"]')).toBeAttached();

    const mid = box.y + box.height / 2;
    await page.mouse.move(box.x + 12, mid);
    await page.mouse.down();

    const positions: number[] = [];
    for (const fraction of [0.3, 0.45, 0.6, 0.75, 0.9]) {
      await page.mouse.move(box.x + box.width * fraction, mid, { steps: 6 });
      const x = await foldX(page);
      if (x !== null) positions.push(x);
    }

    expect(positions.length, 'the fold should engage during the drag').toBeGreaterThan(2);

    // The regression this fork exists to kill is the previous page sliding in
    // from the left. The local curl runs left and `convertToGlobal` mirrors it
    // for BACK, so on screen the current leaf peels to the right.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] ?? 0);
    }

    await page.mouse.up();
  });
});

test.describe('landscape', () => {
  test('renders a two-page spread and turns forward', async ({ page }) => {
    await openBook(page, LANDSCAPE);
    expect(await orientation(page)).toBe('landscape');

    const visible = (await leaves(page)).filter((leaf) => leaf.visible);
    expect(visible.length).toBe(2);
    expect(visible.map((leaf) => leaf.text)).toEqual(['One', 'Two']);

    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');

    await page.mouse.click(box.x + box.width - 20, box.y + 20);
    await expect(page.locator('body[data-page="2"]')).toBeAttached();
  });

  test('the turning leaf paints its own opaque paper mid-fold', async ({ page }) => {
    // Puddlebend Issue 1 was LANDSCAPE-only: the fold's transform+clip-path
    // rode a root whose only opacity was the ::before pseudo, and the two
    // alpha-blended in a band at the fold line. The fix stamps the structural
    // pair on the element itself; this pins it in the orientation that broke,
    // at the DOM level — the goldens alone are a 5%-tolerance pixel diff.
    await openBook(page, LANDSCAPE);

    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');

    const mid = box.y + box.height / 2;
    await dragTo(
      page,
      { x: box.x + box.width - 12, y: mid },
      { x: box.x + box.width * 0.4, y: mid },
    );

    const folding = await page.$$eval('#book .stf__item', (nodes) =>
      nodes
        .map((node) => {
          const el = node as HTMLElement;
          return {
            clipped: el.style.getPropertyValue('clip-path') !== '',
            shown: el.classList.contains('--shown'),
            inlineBase: el.style.getPropertyValue('background-color'),
            inlinePaper: el.style.getPropertyValue('background-image'),
          };
        })
        .filter((leaf) => leaf.clipped && leaf.shown),
    );

    expect(folding.length).toBeGreaterThan(0);
    for (const leaf of folding) {
      expect(leaf.inlineBase).toMatch(/^(#fff|rgb\(255,\s*255,\s*255\))$/);
      expect(leaf.inlinePaper).toContain('linear-gradient(var(--stf-paper');
    }

    await page.mouse.up();
  });

  test('a hard cover turns without leaving the book blank', async ({ page }) => {
    await openBook(page, LANDSCAPE, '?cover=1');

    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');

    await page.mouse.click(box.x + box.width - 20, box.y + 20);
    await expect(page.locator('body[data-page="1"]')).toBeAttached();

    const visible = (await leaves(page)).filter((leaf) => leaf.visible);
    expect(visible.length).toBeGreaterThan(0);
  });
});

test.describe('programmatic turns (buttons, not gestures)', () => {
  // Every other e2e drives the book through pointer gestures, which wake the
  // renderer per input event — so a broken animated `flipNext` (no input
  // stream, pure rAF) had NO real-browser coverage. This is the path every
  // consumer's own chevrons use (the Puddlebend reader's Prev/Next), and the
  // exact path a hidden-tab rAF stall imitates; a test that fails here and
  // passes in gestures.spec points at the scheduler, not the geometry.
  test('the Next and Prev buttons complete animated turns', async ({ page }) => {
    await openBook(page, LANDSCAPE);

    await page.locator('#next').click();
    await expect(page.locator('body[data-page="2"]')).toBeAttached();

    // 4 pages = 2 landscape spreads, so head 2 is the end: the boundary is
    // reported (canTurn → chrome disables) rather than a dead click.
    await expect(page.locator('#next')).toBeDisabled();

    await page.locator('#prev').click();
    await expect(page.locator('body[data-page="0"]')).toBeAttached();
    await expect(page.locator('#prev')).toBeDisabled();
  });

  test('First is an instant jump, not a fan of turns', async ({ page }) => {
    await openBook(page, LANDSCAPE);

    await page.locator('#next').click();
    await expect(page.locator('body[data-page="2"]')).toBeAttached();

    // turnToPage(0): commits without an animation frame in between.
    await page.locator('#first').click();
    await expect(page.locator('body[data-page="0"]')).toBeAttached();
  });
});

test.describe('reading direction', () => {
  test('rtl turns forward from the left edge', async ({ page }) => {
    await openBook(page, PORTRAIT, '?rtl=1');

    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');

    await page.mouse.click(box.x + 20, box.y + 20);
    await expect(page.locator('body[data-page="1"]')).toBeAttached();
  });
});
