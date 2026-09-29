/* global window, document */
// Probe 2: which page gets cloned, and what a cloned <video> looks like — landscape back-turn and portrait.
import { chromium, webkit } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4199/docs/requests/video-pages';
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const clones = `(() => [...document.querySelectorAll('[data-stf-clone]')].map(c => ({
  id: c.id, cls: c.className, videos: [...c.querySelectorAll('video')].map(v => ({
    paused: v.paused, t: +v.currentTime.toFixed(2), ready: v.readyState, net: v.networkState,
    autoplay: v.autoplay, muted: v.muted, src: v.currentSrc.split('/').pop(), poster: v.poster,
    w: v.getBoundingClientRect().width|0, h: v.getBoundingClientRect().height|0 })) })))()`;

async function run(name, bt) {
  const browser = await bt.launch();
  const log = (...a) => console.log(`[${name}]`, ...a);
  try {
    for (const portrait of [false, true]) {
      const page = await browser.newPage({
        viewport: { width: portrait ? 480 : 1000, height: 700 },
      });
      const hits = [];
      page.on('request', (r) => {
        if (r.url().endsWith('.mp4')) hits.push(r.url().split('/').pop());
      });
      await page.goto(`${BASE}/fixture.html?t=2000&portrait=${portrait ? 1 : 0}`);
      await page.waitForSelector('body[data-ready="1"]');
      const mode = portrait ? 'portrait' : 'landscape';
      // Land on the loop-video page, let it play, then turn BACK so the video leaf itself folds.
      await page.evaluate(() => window.flipbook.turnToPage(2));
      await page.waitForTimeout(1200);
      log(
        mode,
        'visible pages',
        JSON.stringify(await page.evaluate(() => window.flipbook.getVisiblePages())),
        'orientation',
        await page.evaluate(() => window.flipbook.getOrientation()),
      );
      const before = hits.length;
      await page.evaluate(() => window.flipbook.flipPrev());
      await page.waitForTimeout(700);
      log(mode, 'flipPrev mid-turn clones:', JSON.stringify(await page.evaluate(clones)));
      log(
        mode,
        'original loop video mid-turn:',
        JSON.stringify(
          await page.evaluate(() => {
            const v = document.querySelector('#v-loop');
            return {
              paused: v.paused,
              t: +v.currentTime.toFixed(2),
              rect: v.getBoundingClientRect().width | 0,
            };
          }),
        ),
      );
      await page.screenshot({
        path: `${OUT}${name}-${mode}-flipPrev-midturn.png`,
      });
      await page.waitForTimeout(1800);
      log(mode, 'extra mp4 requests caused by the turn:', JSON.stringify(hits.slice(before)));
      // Forward from the video page too.
      await page.evaluate(() => window.flipbook.turnToPage(2));
      await page.waitForTimeout(600);
      await page.evaluate(() => window.flipbook.flipNext());
      await page.waitForTimeout(700);
      log(mode, 'flipNext mid-turn clones:', JSON.stringify(await page.evaluate(clones)));
      await page.screenshot({
        path: `${OUT}${name}-${mode}-flipNext-midturn.png`,
      });
      await page.waitForTimeout(1800);
      // Focused <video controls>: do arrow keys turn the page?
      await page.evaluate(() => window.flipbook.turnToPage(3));
      await page.waitForTimeout(500);
      const idx0 = await page.evaluate(() => window.flipbook.getCurrentPageIndex());
      await page.focus('#v-controls');
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(2500);
      log(
        mode,
        `ArrowRight on focused <video controls>: page ${idx0} -> ${await page.evaluate(() => window.flipbook.getCurrentPageIndex())}`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
for (const [n, b] of [
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  try {
    await run(n, b);
  } catch (e) {
    console.error(`[${n}] ERROR`, e.message);
    process.exitCode = 1;
  }
}
