import { expect, test, type Page } from '@playwright/test';

/**
 * F01 — live HTML picture-book fixture.
 *
 * Runs against `examples/mobile-reader` (port 4174). Assertions are structural:
 * real story text, no whole-page raster, no duplicate accessible copies, and
 * driven next/prev plus a held fold. Not a physical WebView sign-off.
 */

test.use({ baseURL: 'http://127.0.0.1:4174' });

const PORTRAIT = { width: 420, height: 800 };
const LANDSCAPE = { width: 1100, height: 700 };

async function openFixture(page: Page, size: { width: number; height: number }, query = '') {
  await page.setViewportSize(size);
  await page.goto(`/${query}`);
  await expect(page.locator('body[data-ready="1"]')).toBeAttached();
  await expect(page.locator('#book .stf__block')).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

function settle(page: Page) {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function storyText(page: Page): Promise<string> {
  return page.locator('#book').innerText();
}

async function runFixtureAssertions(page: Page): Promise<void> {
  const text = await storyText(page);
  expect(text).toContain('The River Stone');
  expect(text).toMatch(/Live HTML fixture/i);

  const dom = await page.locator('#book').textContent();
  expect(dom).toContain('Mara');
  expect(dom).toContain('smooth');
  expect(dom).toMatch(/stone/i);

  const pageRoots = page.locator('#book .stf__item:not([data-stf-clone])');
  await expect(pageRoots).toHaveCount(10);

  // Pages are live HTML, not a stack of full-bleed rasters substituting the book.
  const rasterPages = await page.locator('#book .stf__item:not([data-stf-clone])').evaluateAll(
    (nodes) =>
      nodes.filter((node) => {
        const imgs = [...node.querySelectorAll('img')];
        if (imgs.length === 0) return false;
        const onlyRaster =
          node.childElementCount === 1 && node.querySelector(':scope > img') !== null;
        return onlyRaster;
      }).length,
  );
  expect(rasterPages).toBe(0);

  const box = await page.locator('#book .stf__block').boundingBox();
  if (!box) throw new Error('no book box');
  expect(box.width).toBeGreaterThan(120);
  expect(box.height).toBeGreaterThan(120);

  const ready = await page.evaluate(() => {
    const book = (window as unknown as { flipbook: { isAnimating(): boolean; getState(): string } })
      .flipbook;
    return { animating: book.isAnimating(), state: book.getState() };
  });
  expect(ready.animating).toBe(false);
  expect(ready.state).toBe('read');
}

test.describe('F01 live HTML mobile-reader fixture', () => {
  for (const pass of [1, 2] as const) {
    test(`loads with visible story text (pass ${pass})`, async ({ page }) => {
      await openFixture(page, LANDSCAPE);
      await runFixtureAssertions(page);
    });
  }

  test('next/prev and a held fold change the visible book without duplicating a11y copies', async ({
    page,
  }) => {
    await openFixture(page, PORTRAIT, '?reducedMotion=0&flippingTime=800');
    await expect(page.locator('body')).toHaveAttribute('data-orientation', 'portrait');

    const identitiesBefore = await page.evaluate(() =>
      [...document.querySelectorAll('#book .page:not([data-stf-clone])')].map(
        (el) => (el as HTMLElement).dataset.pageId,
      ),
    );

    await page.locator('#next').click();
    await expect(page.locator('body[data-page="1"]')).toBeAttached({ timeout: 5000 });
    await expect(page.locator('#book')).toContainText('Inside cover');

    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');
    const mid = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 10, mid);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.35, mid, { steps: 10 });
    await settle(page);

    const clones = page.locator('#book .stf__item[data-stf-clone]');
    const cloneCount = await clones.count();
    expect(cloneCount).toBeGreaterThan(0);
    for (let i = 0; i < cloneCount; i += 1) {
      await expect(clones.nth(i)).toHaveAttribute('aria-hidden', 'true');
      await expect(clones.nth(i)).toHaveAttribute('inert', '');
    }

    const originals = page.locator('#book .page:not([data-stf-clone])');
    const originalCount = await originals.count();
    for (let i = 0; i < originalCount; i += 1) {
      await expect(originals.nth(i)).not.toHaveAttribute('aria-hidden', 'true');
    }

    await page.mouse.up();
    await page.locator('#prev').click();

    const identitiesAfter = await page.evaluate(() =>
      [...document.querySelectorAll('#book .page:not([data-stf-clone])')].map(
        (el) => (el as HTMLElement).dataset.pageId,
      ),
    );
    expect(identitiesAfter).toEqual(identitiesBefore);

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const book = (window as unknown as { flipbook: { isAnimating(): boolean } }).flipbook;
          return book.isAnimating();
        }),
      )
      .toBe(false);
  });

  test('page-progression RTL is independent of the Arabic sample dir', async ({ page }) => {
    await openFixture(page, LANDSCAPE, '?rtl=1');
    await expect(page.locator('#rtl-toggle')).toContainText('RTL');
    await expect(page.locator('[data-page-id="rtl-sample"]')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('[data-page-id="rtl-sample"]')).toContainText('الحجر');

    await page.locator('#rtl-toggle').click();
    await expect(page.locator('#rtl-toggle')).toContainText('LTR');
    await expect(page.locator('[data-page-id="rtl-sample"]')).toHaveAttribute('dir', 'rtl');
  });

  test('narration clock restyles tokens via a sheet outside page subtrees', async ({ page }) => {
    await openFixture(page, LANDSCAPE);
    await expect
      .poll(async () => page.locator('body').getAttribute('data-highlight'))
      .toMatch(/^sample-en-/);

    const sameNode = await page.evaluate(async () => {
      const book = (
        window as unknown as {
          flipbook: { getPageElement(i: number): HTMLElement | null };
        }
      ).flipbook;
      const before = book.getPageElement(2);
      await new Promise((resolve) => {
        window.setTimeout(resolve, 800);
      });
      return before !== null && before === book.getPageElement(2);
    });
    expect(sameNode).toBe(true);
  });
});
