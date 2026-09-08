/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pinch-zoom` is listed alongside `pan-y` deliberately. `touch-action:pan-y`
// alone tells the browser that vertical panning is the ONLY gesture it may
// handle itself — which silently disables pinch-to-zoom over the whole book.
// For a low-vision reader, magnifying the page is the primary way to read it,
// and a picture book is exactly the content people zoom into (WCAG 1.4.4
// Resize Text / 1.4.10 Reflow; disabling zoom is the classic failure). Adding
// the keyword hands two-finger zoom back to the browser while leaving
// single-finger horizontal drags — the page fold — to the engine, which is the
// only gesture `pan-y` was there to protect.
export const FLIPBOOK_CSS =
  '.stf__parent{position:relative;display:block;box-sizing:border-box;transform:translateZ(0);-ms-touch-action:pan-y pinch-zoom;touch-action:pan-y pinch-zoom}' +
  // Live: `allowTouchScroll: false` drops pan-y so the compositor will not
  // steal a vertical swipe. Pinch-zoom stays (WCAG 1.4.4 / 1.4.10).
  '.stf__parent.--lock-touch-scroll{-ms-touch-action:pinch-zoom;touch-action:pinch-zoom}' +
  '.stf__wrapper{position:relative;width:100%;box-sizing:border-box}' +
  '.stf__block{position:absolute;width:100%;height:100%;box-sizing:border-box;perspective:2000px;user-select:none;-webkit-user-select:none;-webkit-user-drag:none;user-drag:none}' +
  // VISIBILITY, not display — the two must not share a property.
  //
  // Moving the hidden state to a `display` CLASS fixed inline `display:flex`
  // (inline beats a class) and left a consumer's own CLASS losing or tying:
  // `.stf__item.--shown` is (0,2,0), so `.ds-page{display:flex}` loses and
  // `.book .ds-page` ties and is decided by bundler-dependent document order.
  // Design systems style with classes, which is the consumer this was fixed
  // for.
  //
  // `visibility` decouples the axes so they cannot collide at any specificity.
  // The leaves are absolutely positioned, so a hidden one costs no layout; it
  // is not hit-testable and is skipped by find-in-page, which is what the old
  // `display:none` bought.
  '.stf__item{visibility:hidden;position:absolute;transform-style:preserve-3d}' +
  '.stf__item.--shown{visibility:visible}' +
  // THE PAPER's backstop layer. The primary paint is the SAME structural pair
  // stamped inline on every drawn leaf by `applyEngineStyle` (Page.ts) —
  // the fold puts `transform` + `clip-path` on the leaf root, and opacity
  // that lives only on a `z-index:-1` pseudo proved fragile against
  // compositor behavior (Puddlebend Issue 1: a translucent band at the fold
  // line in landscape). The pseudo remains for any state the engine has not
  // drawn, and as the belt to the element's braces.
  //
  // NOTE the negative z-index is NOT "behind the element's own background":
  // a drawn leaf carries an inline z-index and `preserve-3d`, so it is a
  // stacking context and negative-z children paint ABOVE the root's own
  // background. Per-page colour therefore goes through `pageBackground` /
  // `--stf-paper` or an inner element, never the root's background — which is
  // what the README documents.
  //
  // B3: opacity is STRUCTURAL. The consumer's value is the image layer,
  // painted over an opaque `background-color` base — so a translucent
  // `--stf-paper` (`var()` with a transparent fallback, `color-mix`, a
  // `calc()` alpha, any syntax CSS grows next) composites over white instead
  // of letting the page underneath read through. There is deliberately no
  // alpha parser anywhere: a guarantee by construction cannot be bypassed by
  // a syntax the parser has not met.
  '.stf__item::before{content:"";position:absolute;inset:0;z-index:-1;' +
  'background-color:#fff;' +
  'background-image:linear-gradient(var(--stf-paper,#fff),var(--stf-paper,#fff));' +
  'pointer-events:none}' +
  // NO display rule for shown leaves. `.stf__item.--shown{display:block}` was
  // (0,2,0), which silently beat a design system's `.page{display:flex}` —
  // the exact consumer the inline-stamp removal was for, losing to the same
  // engine one selector later. Show/hide lives on the `visibility` axis
  // alone; an absolutely positioned leaf is block-level without help, and a
  // consumer's `display` is theirs at every specificity.
  '.stf__outerShadow,.stf__innerShadow,.stf__hardShadow,.stf__hardInnerShadow{position:absolute;left:0;top:0}' +
  // The book root's focus ring, and the H4 controls' skip-link reveal.
  //
  // Here rather than in a React `<style>` tag: an inline stylesheet is blocked
  // by a strict CSP without 'unsafe-inline', which took the reveal with it — a
  // sighted keyboard user then focused a control they could not see. The
  // accessibility contract held either way (the controls stay in the a11y tree
  // and the tab order), but the visible affordance is the point of revealing
  // them at all. This sheet is injected once per document.
  '[data-flipbook-kb]:focus{outline:none}' +
  '[data-flipbook-kb]:focus-visible{outline:2px solid #2563eb;outline-offset:2px}' +
  '[data-flipbook-controls]:focus-within{position:static!important;width:auto!important;' +
  'height:auto!important;margin:0!important;overflow:visible!important;clip:auto!important;' +
  'clip-path:none!important;white-space:normal!important}';

const STYLE_ATTR = 'data-gullabs-flipbook';

export function ensureFlipbookStyles(): void {
  if (typeof document === 'undefined') {
    return;
  }
  if (document.head.querySelector(`style[${STYLE_ATTR}]`)) {
    return;
  }
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  style.textContent = FLIPBOOK_CSS;
  document.head.appendChild(style);
}
