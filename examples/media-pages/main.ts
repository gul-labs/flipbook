import { PageFlip } from '@gullabs/flipbook-core';
import { attachMediaPolicy } from './media';
import { generateMedia } from './source';

const root = document.getElementById('book');
if (!(root instanceof HTMLElement)) throw new Error('#book is required');

const params = new URLSearchParams(window.location.search);
const media = generateMedia('flipbook');

function mediaSlot<T extends HTMLMediaElement>(name: string, type: new () => T): T {
  const el = root?.querySelector(`[data-media="${name}"]`);
  if (!(el instanceof type)) throw new Error(`missing [data-media="${name}"]`);
  return el;
}

// Real books use files. The generated streams keep this example offline.
const loop = mediaSlot('loop', HTMLVideoElement);
const clip = mediaSlot('clip', HTMLVideoElement);
const narration = mediaSlot('audio', HTMLAudioElement);
const file = params.get('video');
if (file !== null) {
  clip.src = file;
} else {
  clip.srcObject = media.withSound;
}
loop.srcObject = media.picture;
narration.srcObject = media.sound;

// YouTube: enablejsapi=1 lets `pauseEmbeds` pause it; playsinline=1 keeps it in
// the page on iPhone; the origin parameter scopes the API messages to this page.
const youtube = params.get('youtube');
if (youtube !== null && /^[\w-]{6,20}$/.test(youtube)) {
  const frame = document.createElement('iframe');
  const url = new URL(`https://www.youtube-nocookie.com/embed/${youtube}`);
  url.searchParams.set('enablejsapi', '1');
  url.searchParams.set('playsinline', '1');
  url.searchParams.set('origin', window.location.origin);
  frame.src = url.href;
  frame.title = 'Embedded video';
  frame.allow = 'autoplay; encrypted-media; picture-in-picture';
  frame.allowFullscreen = true;
  root.querySelector('[data-media="embed"]')?.replaceChildren(frame);
}

const book = new PageFlip(root, {
  width: 400,
  height: 520,
  sizing: 'responsive',
  minWidth: 240,
  maxWidth: 520,
  minHeight: 300,
  maxHeight: 680,
  usePortrait: true,
  flippingTime: Number(params.get('flippingTime') ?? 700),
  pageBackground: '#fffaf0',
  respectInteractiveContent: true,
  foldCornerOnHover: true,
});
book.loadFromHTML([...root.querySelectorAll<HTMLElement>('.page')]);

const detach = attachMediaPolicy(book);

document.getElementById('unlock')?.addEventListener('click', () => {
  // A user gesture. `play()` must be called inside it, not after an await:
  // Safari only honours the gesture synchronously.
  clip.play().catch(() => {});
  void media.unlock();
});
document.getElementById('prev')?.addEventListener('click', () => book.flipPrev());
document.getElementById('next')?.addEventListener('click', () => book.flipNext());

const status = document.getElementById('status');
const report = (): void => {
  if (status === null) return;
  const line = (name: string, el: HTMLMediaElement): string =>
    `${name.padEnd(6)} ${el.paused ? 'paused ' : 'playing'}${el.muted ? ' (muted)' : ''}`;
  status.textContent = [
    `state ${book.getState()}  pages ${book.getVisiblePages().join(',')}`,
    line('loop', loop),
    line('clip', clip),
    line('audio', narration),
  ].join('\n');
};
for (const el of [loop, clip, narration]) {
  el.addEventListener('play', report);
  el.addEventListener('pause', report);
}
book.on('changeState', report);
book.on('flip', report);
report();

// Test harness handle (e2e/media-pages.spec.ts); not consumer teaching material.
Object.assign(window, { mediaDemo: { book, detach, loop, clip, narration } });
