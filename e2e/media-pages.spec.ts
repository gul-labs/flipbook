/**
 * Host-owned media playback (`examples/media-pages`, port 4175).
 *
 * Proves the documented recipe (`examples/media-pages/media.ts`,
 * `docs/MEDIA-PAGES.md`) against the real engine in a real browser: sound
 * pauses when a turn starts and before the portrait copy is taken, an
 * abandoned turn resumes it, pages that leave the screen stop, muted loops
 * run on arrival, and the fold never holds a second player.
 */
import { expect, test, type Page } from '@playwright/test';

const URL = 'http://127.0.0.1:4175/';

interface Demo {
  book: {
    flipNext(): boolean;
    turnToPage(page: number): void;
    getCurrentPageIndex(): number;
    getState(): string;
    on(event: string, cb: (e: { data: unknown }) => void): unknown;
    getBoundsRect(): { left: number; top: number; width: number; height: number };
    getBlockElement(): HTMLElement;
  };
  loop: HTMLVideoElement;
  clip: HTMLVideoElement;
  narration: HTMLAudioElement;
}

async function open(page: Page, query = ''): Promise<void> {
  // Narrow viewport: portrait, one leaf per spread, so turns use the fold copy.
  await page.setViewportSize({ width: 460, height: 820 });
  await page.goto(URL + query);
  await page.waitForFunction(() => 'mediaDemo' in window);
}

async function goTo(page: Page, index: number): Promise<void> {
  await page.evaluate((i) => {
    (window as unknown as { mediaDemo: Demo }).mediaDemo.book.turnToPage(i);
  }, index);
}

async function startClip(page: Page): Promise<void> {
  await goTo(page, 2);
  // A real click: the user gesture that allows sound.
  await page.click('#unlock');
  await page.waitForFunction(
    () => !(window as unknown as { mediaDemo: Demo }).mediaDemo.clip.paused,
  );
}

test('a turn pauses sound before the fold copy exists, and the fold holds no second player', async ({
  page,
}) => {
  await open(page);
  await startClip(page);

  const atFlipping = await page.evaluate(
    () =>
      new Promise<{ clipPaused: boolean; clones: number; frames: number; players: number }>(
        (resolve) => {
          const { book, clip } = (window as unknown as { mediaDemo: Demo }).mediaDemo;
          const block = book.getBlockElement();
          book.on('changeState', ({ data }) => {
            if ((data as { state: string }).state !== 'flipping') return;
            // Next microtask: the clone is taken right after this dispatch.
            queueMicrotask(() =>
              resolve({
                clipPaused: clip.paused,
                clones: block.querySelectorAll('[data-stf-clone]').length,
                frames: block.querySelectorAll('[data-stf-clone] canvas[data-stf-frame]').length,
                players: block.querySelectorAll('[data-stf-clone] video, [data-stf-clone] audio')
                  .length,
              }),
            );
          });
          book.flipNext();
        },
      ),
  );
  expect(atFlipping).toEqual({ clipPaused: true, clones: 1, frames: 1, players: 0 });

  await page.waitForFunction(
    () => (window as unknown as { mediaDemo: Demo }).mediaDemo.book.getState() === 'read',
  );
  const after = await page.evaluate(() => {
    const { book, clip } = (window as unknown as { mediaDemo: Demo }).mediaDemo;
    return { page: book.getCurrentPageIndex(), clipPaused: clip.paused };
  });
  expect(after).toEqual({ page: 3, clipPaused: true });
});

test('an abandoned drag resumes the sound it paused', async ({ page }) => {
  await open(page, '?flippingTime=300');
  await startClip(page);

  const box = await page.evaluate(() =>
    (window as unknown as { mediaDemo: Demo }).mediaDemo.book.getBoundsRect(),
  );
  const y = box.top + box.height - 12;
  const x0 = box.left + box.width - 6;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x0 - 30, y, { steps: 4 });
  await page.mouse.move(x0 - 60, y, { steps: 4 });
  expect(
    await page.evaluate(() => (window as unknown as { mediaDemo: Demo }).mediaDemo.clip.paused),
  ).toBe(true);
  await page.mouse.move(x0 - 20, y, { steps: 4 });
  await page.mouse.up();

  await page.waitForFunction(
    () => (window as unknown as { mediaDemo: Demo }).mediaDemo.book.getState() === 'read',
  );
  await page.waitForFunction(
    () => !(window as unknown as { mediaDemo: Demo }).mediaDemo.clip.paused,
  );
  expect(
    await page.evaluate(() =>
      (window as unknown as { mediaDemo: Demo }).mediaDemo.book.getCurrentPageIndex(),
    ),
  ).toBe(2);
});

test('a muted loop starts on arrival, runs through the turn, and stops when its page leaves', async ({
  page,
}) => {
  await open(page);
  await goTo(page, 1);
  await page.waitForFunction(
    () => !(window as unknown as { mediaDemo: Demo }).mediaDemo.loop.paused,
  );

  const midTurn = await page.evaluate(
    () =>
      new Promise<{ loopPaused: boolean; frames: number }>((resolve) => {
        const { book, loop } = (window as unknown as { mediaDemo: Demo }).mediaDemo;
        book.on('changeState', ({ data }) => {
          if ((data as { state: string }).state !== 'flipping') return;
          queueMicrotask(() =>
            resolve({
              loopPaused: loop.paused,
              frames: book.getBlockElement().querySelectorAll('canvas[data-stf-frame]').length,
            }),
          );
        });
        book.flipNext();
      }),
  );
  expect(midTurn).toEqual({ loopPaused: false, frames: 1 });

  await page.waitForFunction(() => {
    const { book, loop } = (window as unknown as { mediaDemo: Demo }).mediaDemo;
    return book.getState() === 'read' && loop.paused;
  });
});

test('reduced motion: the loop does not start on its own', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await goTo(page, 1);
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => (window as unknown as { mediaDemo: Demo }).mediaDemo.loop.paused),
  ).toBe(true);
});
