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
    const book = (
      window as unknown as {
        flipbook: {
          isAnimating(): boolean;
          getState(): string;
          getSettings(): {
            flipOnClick: string;
            foldCornerOnHover: boolean;
            respectInteractiveContent: boolean;
            allowTouchScroll: boolean;
            pointerInput: string[];
          };
        };
      }
    ).flipbook;
    return {
      animating: book.isAnimating(),
      state: book.getState(),
      settings: book.getSettings(),
    };
  });
  expect(ready.animating).toBe(false);
  expect(ready.state).toBe('read');
  expect(ready.settings.flipOnClick).toBe('never');
  expect(ready.settings.foldCornerOnHover).toBe(false);
  expect(ready.settings.respectInteractiveContent).toBe(true);
  expect(ready.settings.allowTouchScroll).toBe(false);
  expect(ready.settings.pointerInput).toEqual(['mouse', 'touch']);
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

    await page.evaluate(() => {
      (window as unknown as { __pageNodes: Element[] }).__pageNodes = [
        ...document.querySelectorAll('#book .page:not([data-stf-clone])'),
      ];
    });

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
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (window as unknown as { flipbook: { isAnimating(): boolean } }).flipbook.isAnimating(),
        ),
      )
      .toBe(false);

    const afterFold = await page.evaluate(() =>
      (
        window as unknown as { flipbook: { getCurrentPageIndex(): number } }
      ).flipbook.getCurrentPageIndex(),
    );
    expect(afterFold).toBe(2);

    await page.locator('#prev').click();
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (window as unknown as { flipbook: { isAnimating(): boolean } }).flipbook.isAnimating(),
        ),
      )
      .toBe(false);

    const afterPrev = await page.evaluate(() =>
      (
        window as unknown as { flipbook: { getCurrentPageIndex(): number } }
      ).flipbook.getCurrentPageIndex(),
    );
    expect(afterPrev).toBe(1);

    const sameNodes = await page.evaluate(() => {
      const before = (window as unknown as { __pageNodes: Element[] }).__pageNodes;
      const now = [...document.querySelectorAll('#book .page:not([data-stf-clone])')];
      return now.length === before.length && now.every((node, i) => node === before[i]);
    });
    expect(sameNodes).toBe(true);
  });

  test('page-progression RTL is independent of the Arabic sample dir', async ({ page }) => {
    await openFixture(page, LANDSCAPE, '?rtl=1&flippingTime=0');
    await expect(page.locator('[data-page-id="rtl-sample"]')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('[data-page-id="rtl-sample"]')).toContainText('الحجر');

    const before = await page.evaluate(() => {
      const book = (
        window as unknown as {
          flipbook: { getSettings(): { readingDirection: string }; getCurrentPageIndex(): number };
        }
      ).flipbook;
      return { dir: book.getSettings().readingDirection, page: book.getCurrentPageIndex() };
    });
    expect(before.dir).toBe('rtl');

    await page.locator('#next').click();
    const afterNext = await page.evaluate(() =>
      (
        window as unknown as { flipbook: { getCurrentPageIndex(): number } }
      ).flipbook.getCurrentPageIndex(),
    );
    expect(afterNext).not.toBe(before.page);

    await page.locator('#rtl-toggle').click();
    const afterToggle = await page.evaluate(
      () =>
        (
          window as unknown as { flipbook: { getSettings(): { readingDirection: string } } }
        ).flipbook.getSettings().readingDirection,
    );
    expect(afterToggle).toBe('ltr');
    await expect(page.locator('[data-page-id="rtl-sample"]')).toHaveAttribute('dir', 'rtl');
  });

  test('a click on the book surface does not turn when flipOnClick is never', async ({ page }) => {
    await openFixture(page, LANDSCAPE);
    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');
    const before = await page.evaluate(() =>
      (
        window as unknown as { flipbook: { getCurrentPageIndex(): number } }
      ).flipbook.getCurrentPageIndex(),
    );
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await settle(page);
    const after = await page.evaluate(() =>
      (
        window as unknown as { flipbook: { getCurrentPageIndex(): number } }
      ).flipbook.getCurrentPageIndex(),
    );
    expect(after).toBe(before);
  });

  test('narration clock restyles tokens via a sheet outside page subtrees', async ({ page }) => {
    await openFixture(page, LANDSCAPE);
    await expect
      .poll(async () => page.locator('body').getAttribute('data-highlight'))
      .toMatch(/^sample-en-/);

    const highlight = await page.evaluate(() => {
      const token = document.body.dataset['highlight'] ?? '';
      const sheet = document.getElementById('highlight-sheet');
      return {
        token,
        sheetText: sheet?.textContent ?? '',
        sheetOutsidePages: sheet !== null && sheet.closest('.stf__item') === null,
      };
    });
    expect(highlight.token).toMatch(/^sample-en-/);
    expect(highlight.sheetOutsidePages).toBe(true);
    expect(highlight.sheetText).toContain(`[data-token-id="${highlight.token}"]`);

    const painted = await page.evaluate((token) => {
      const el = document.querySelector(`[data-token-id="${token}"]`);
      return el === null ? null : getComputedStyle(el).backgroundColor;
    }, highlight.token);
    expect(painted).toBe('rgb(255, 224, 138)');

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

  test('portrait BACK drag curls the current leaf, not a previous one', async ({ page }) => {
    await openFixture(page, PORTRAIT, '?reducedMotion=0&flippingTime=800');
    await page.locator('#next').click();
    await expect(page.locator('body[data-page="1"]')).toBeAttached({ timeout: 5000 });

    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');
    const mid = box.y + box.height / 2;
    await page.mouse.move(box.x + 12, mid);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.65, mid, { steps: 10 });
    await settle(page);

    const clones = page.locator('#book .stf__item[data-stf-clone]');
    expect(await clones.count()).toBeGreaterThan(0);
    await expect(clones.first()).toHaveAttribute('aria-hidden', 'true');
    await expect(clones.first()).toContainText('Inside cover');

    const insideCopies = await page
      .locator('#book .stf__item')
      .evaluateAll(
        (nodes) => nodes.filter((node) => (node.textContent ?? '').includes('Inside cover')).length,
      );
    expect(insideCopies).toBe(2);
    await expect(page.locator('#book [data-page-id="cover"]:not([data-stf-clone])')).toContainText(
      'The River Stone',
    );

    await page.mouse.up();
  });

  test('highlight paints original and fold clone during a held curl', async ({ page }) => {
    await openFixture(page, PORTRAIT, '?flippingTime=800&reducedMotion=0');
    await page.locator('#next').click();
    await expect(page.locator('body[data-page="1"]')).toBeAttached({ timeout: 5000 });
    await page.locator('#next').click();
    await expect.poll(async () => page.locator('body').getAttribute('data-page')).toBe('2');

    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');
    const mid = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 10, mid);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, mid, { steps: 8 });
    await settle(page);

    const painted = await page.evaluate(() => {
      // Change the shared rule AFTER cloning, then observe both faces in the
      // same task. The running narration clock cannot race these assertions.
      const token = 'sample-en-page3-word2';
      const sheet = document.getElementById('highlight-sheet');
      if (!sheet) throw new Error('missing highlight sheet');
      sheet.textContent = `[data-token-id="${token}"] { background: #ffe08a; }`;
      document.body.dataset['highlight'] = token;
      const original = document.querySelector(
        `.stf__item:not([data-stf-clone]) [data-token-id="${token}"]`,
      );
      const clone = document.querySelector(`.stf__item[data-stf-clone] [data-token-id="${token}"]`);
      return {
        token,
        original: original === null ? null : getComputedStyle(original).backgroundColor,
        clone: clone === null ? null : getComputedStyle(clone).backgroundColor,
        cloneCount: document.querySelectorAll('[data-stf-clone]').length,
      };
    });
    expect(painted.cloneCount).toBeGreaterThan(0);
    expect(painted.token).toBe('sample-en-page3-word2');
    expect(painted.original).toBe('rgb(255, 224, 138)');
    expect(painted.clone).toBe('rgb(255, 224, 138)');

    await page.mouse.up();
  });

  test('lazy window parks distant leaves and keeps neighbors hydrated', async ({ page }) => {
    await openFixture(page, LANDSCAPE);
    const hydrated = async (leaf: string) =>
      page.evaluate((id) => {
        const slot = document.querySelector(`[data-leaf="${id}"] [data-lazy="full"]`);
        return slot instanceof HTMLElement ? slot.dataset.hydrated : null;
      }, leaf);

    expect(await hydrated('2')).toBe('1');
    expect(await hydrated('4')).toBe('0');

    await page.locator('#next').click();
    await expect.poll(async () => page.locator('body').getAttribute('data-page')).not.toBe('0');
    await expect.poll(async () => hydrated('4')).toBe('1');

    for (let i = 0; i < 4; i += 1) {
      await page.locator('#next').click();
      await expect
        .poll(async () =>
          page.evaluate(() =>
            (window as unknown as { flipbook: { isAnimating(): boolean } }).flipbook.isAnimating(),
          ),
        )
        .toBe(false);
    }
    await expect.poll(async () => hydrated('2')).toBe('0');
  });

  test('engine is ready before the delayed local font finishes', async ({ page }) => {
    await page.setViewportSize(LANDSCAPE);
    await page.goto('/');
    await expect(page.locator('body[data-ready="1"]')).toBeAttached();
    expect(await page.locator('body').getAttribute('data-font-ready')).toBe('0');
    const beforeFamily = await page
      .locator('.story-text')
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(beforeFamily.toLowerCase()).not.toContain('storydisplay');
    await expect.poll(async () => page.locator('body').getAttribute('data-font-ready')).toBe('1');
    await expect
      .poll(async () => page.evaluate(() => document.fonts.check('1em StoryDisplay')))
      .toBe(true);
    const afterFamily = await page
      .locator('.story-text')
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(afterFamily.toLowerCase()).toContain('storydisplay');
    expect(afterFamily).not.toBe(beforeFamily);
  });

  test('a touch pointer is accepted and preventDefault when allowTouchScroll is false', async ({
    page,
  }) => {
    await openFixture(page, PORTRAIT, '?flippingTime=0');
    const result = await page.evaluate(() => {
      const block = document.querySelector('#book .stf__block');
      if (!(block instanceof HTMLElement)) return { prevented: false, state: 'missing' };
      const rect = block.getBoundingClientRect();
      const down = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'touch',
        button: 0,
        buttons: 1,
        clientX: rect.right - 12,
        clientY: rect.top + rect.height / 2,
      });
      block.dispatchEvent(down);
      const move = new PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'touch',
        button: 0,
        buttons: 1,
        clientX: rect.right - 80,
        clientY: rect.top + rect.height / 2,
      });
      block.dispatchEvent(move);
      const book = (window as unknown as { flipbook: { getState(): string } }).flipbook;
      return {
        downPrevented: down.defaultPrevented,
        movePrevented: move.defaultPrevented,
        state: book.getState(),
        lockClass:
          document.getElementById('book')?.classList.contains('--lock-touch-scroll') === true,
      };
    });
    expect(result.lockClass).toBe(true);
    expect(result.downPrevented).toBe(false);
    expect(result.movePrevented).toBe(true);
    expect(result.state).not.toBe('read');
  });

  test('host width change mid-fold cancels to the committed page', async ({ page }) => {
    await openFixture(page, LANDSCAPE, '?reducedMotion=0&flippingTime=800');
    const before = await page.evaluate(() =>
      (
        window as unknown as { flipbook: { getCurrentPageIndex(): number } }
      ).flipbook.getCurrentPageIndex(),
    );

    const box = await page.locator('#book .stf__block').boundingBox();
    if (!box) throw new Error('no book box');
    const mid = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 10, mid);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, mid, { steps: 8 });
    await settle(page);

    const folding = await page.evaluate(() =>
      (window as unknown as { flipbook: { getState(): string } }).flipbook.getState(),
    );
    expect(folding).not.toBe('read');

    await page.locator('#host-width').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '360';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(page);

    await expect
      .poll(async () =>
        page.evaluate(() =>
          (window as unknown as { flipbook: { getState(): string } }).flipbook.getState(),
        ),
      )
      .toBe('read');

    const after = await page.evaluate(() =>
      (
        window as unknown as { flipbook: { getCurrentPageIndex(): number } }
      ).flipbook.getCurrentPageIndex(),
    );
    expect(after).toBe(before);
    await page.mouse.up();
  });
});

test('explicit reduced motion changes actual turns and still honors the OS', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openFixture(page, PORTRAIT, '?reducedMotion=1&flippingTime=800');
  const next = () =>
    page.evaluate(() => {
      const app = (
        window as unknown as {
          flipbook: {
            flipNext(): boolean;
            isAnimating(): boolean;
            cancelTurn(): boolean;
          };
        }
      ).flipbook;
      const accepted = app.flipNext();
      const animating = app.isAnimating();
      app.cancelTurn();
      return { accepted, animating };
    });
  expect(await next()).toEqual({ accepted: true, animating: false });
  await page.locator('#motion-toggle').click();
  expect(await next()).toEqual({ accepted: true, animating: true });
  await page.locator('#motion-toggle').click();
  expect(await next()).toEqual({ accepted: true, animating: false });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#motion-toggle').click();
  expect(await next()).toEqual({ accepted: true, animating: false });
});
