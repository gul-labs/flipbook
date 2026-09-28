/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Render } from '../Render/Render';
import { rotatePoint } from '../Helper';
import { FlipDirection } from '../Flip/Flip';
import type { Point } from '../BasicTypes';
import { foldFill } from '../Render/pageBackground';
import { PageFlipError } from '../errors';

/**
 * State of the page on the basis of which rendering
 */
export interface PageState {
  /** Page rotation angle */
  angle: number;

  /** Page scope. `null` entries are skipped by the renderers. */
  area: (Point | null)[];

  /** Page position */
  position: Point;

  /** Rotate angle for hard pages */
  hardAngle: number;

  /** Rotate angle for hard pages at renedering time */
  hardDrawingAngle: number;
}

export const PageOrientation = {
  LEFT: 0,
  RIGHT: 1,
} as const;
export type PageOrientation = (typeof PageOrientation)[keyof typeof PageOrientation];

export const PageDensity = {
  SOFT: 'soft',
  HARD: 'hard',
} as const;
export type PageDensity = (typeof PageDensity)[keyof typeof PageDensity];

/**
 * Every CSS property the engine writes on a leaf. NF4.
 *
 * The draw paths used to assign `style.cssText` wholesale, which REPLACES the
 * element's entire inline style. Adopted leaves get a snapshot restored when
 * they are released, so a vanilla consumer never noticed — but React-portalled
 * leaves are never adopted, so a consumer's `style={{ borderRadius: 8 }}` on a
 * page element was destroyed on the first frame and every frame after, with
 * nothing to restore it and no way to work around it short of `!important`.
 *
 * Listing the engine's own properties is what makes a surgical write possible:
 * anything NOT on this list belongs to the consumer and is left alone. It must
 * stay in sync with the draw paths below — a property written but not listed
 * would never be cleared when a later frame stops writing it, and would stick.
 */
const ENGINE_STYLE_PROPS = [
  'position',
  'z-index',
  'left',
  'top',
  'width',
  'height',
  'background-color',
  'background-image',
  '--stf-paper',
  'pointer-events',
  'transform',
  'transform-origin',
  'clip-path',
  '-webkit-clip-path',
  'backface-visibility',
  '-webkit-backface-visibility',
] as const;

// applyEngineStyle lives on Page as a method so it can memoize last-written
// css + background per leaf (PLAN-3.1 B3.1). See Page.applyEngineStyle.

/**
 * Every class this renderer puts on a consumer's leaf element.
 *
 * Kept here, next to the code that adds them (`constructor`, `simpleDraw`,
 * `setOrientation`, `setDrawingDensity`), because the list only stays correct
 * if it lives beside the additions. `UI.clear()` reads it to hand the
 * nodes back undressed — see U1 there.
 */
export const ENGINE_LEAF_CLASSES = [
  'stf__item',
  '--soft',
  '--hard',
  '--left',
  '--right',
  '--simple',
  '--shown',
] as const;

/**
 * ClassList mutators that no-op when the class is already present/absent
 * (PLAN-3.1 B3.4). Per-frame draw paths used unconditional add/remove, which
 * the write recorder counts even when the DOM attribute is unchanged.
 * Do NOT use these in setOrientation/setDensity/setDrawingDensity — those are
 * per-event and their remove-then-add pattern is load-bearing.
 */
function addClass(el: HTMLElement, cls: string): void {
  if (!el.classList.contains(cls)) el.classList.add(cls);
}

function removeClass(el: HTMLElement, cls: string): void {
  if (el.classList.contains(cls)) el.classList.remove(cls);
}

/**
 * Class representing a book page as an HTML Element.
 *
 * COLLAPSED from an abstract `Page` plus a single `HTMLPage` subclass. The
 * subclass held the entire draw path; the base held density/orientation state.
 * That is not a renderer seam — it is one leaf class split at an arbitrary
 * line. See `docs/ABSTRACTION-BOUNDARY.md`.
 */
export class Page {
  /** State of the page on the basis of which rendering */
  private state: PageState;
  /** Render object */
  private render: Render;

  /** Page Orientation */
  private orientation: PageOrientation = PageOrientation.RIGHT;

  /** Density at creation */
  private createdDensity: PageDensity;
  /** Density at the time of rendering (Depends on neighboring pages) */
  private nowDrawingDensity: PageDensity;

  private readonly element: HTMLElement;
  private copiedElement: HTMLElement | null = null;

  private temporaryCopy: Page | null = null;

  /**
   * Last css string + background this leaf wrote via `applyEngineStyle`
   * (PLAN-3.1 B3.1). `null` means "no cache" — next draw always stamps.
   * Invalidated on orientation/density changes, adopt/release, and collection
   * `invalidateDrawCache()` (resize / settings / reload).
   */
  private lastEngineCss: string | null = null;
  private lastBackground: string | undefined = undefined;

  /**
   * True only for the throwaway leaf built by `newTemporaryCopy()`.
   *
   * `draw()` re-emits the engine's declarations every frame, so anything the
   * clone needs in its inline style has to be re-emitted too rather than set once
   * at clone time. Private, and set by `newTemporaryCopy` on the *other*
   * instance — legal because TypeScript's `private` is per-class, not
   * per-instance.
   */
  private isTemporaryCopy = false;

  /**
   * Back-reference from a temporary copy to the leaf that owns it (PLAN-3.1
   * B3.2). `null` on every real leaf. The renderer only ever holds the clone
   * (`setFlippingPage`), and `hideTemporaryCopy()` must run on the OWNER —
   * ownership used to exist only owner→clone, so a delta clear that saw the
   * clone leave the working set had no constant-time path to the owner.
   * Set by `newTemporaryCopy` on the clone (same per-class private access as
   * `isTemporaryCopy`).
   */
  private copyOwner: Page | null = null;

  constructor(render: Render, element: HTMLElement, density: PageDensity) {
    this.state = {
      angle: 0,
      area: [],
      position: { x: 0, y: 0 },
      hardAngle: 0,
      hardDrawingAngle: 0,
    };

    this.createdDensity = density;
    this.nowDrawingDensity = this.createdDensity;

    this.render = render;

    this.element = element;
    this.element.classList.add('stf__item');
    this.element.classList.add(`--${density}`);
  }

  public newTemporaryCopy(): Page {
    if (this.nowDrawingDensity === PageDensity.HARD) {
      return this;
    }

    if (this.temporaryCopy === null) {
      // U8. This was `this.element.parentElement?.appendChild(...)` below. A
      // detached leaf (a React unmount racing a turn, a consumer removing a
      // page node) made the optional chain a silent no-op — and the copy was
      // still built, still returned, and still animated, so the turn ran to
      // completion against a node that is not in the document: no fold, no
      // error, and a `hideTemporaryCopy()` that "cleans up" something that was
      // never there. The optional chain turned a broken state into an invisible
      // one. There is no correct rendering for a detached leaf, so say so — and
      // say it before anything is cloned or assigned, so a caller that catches
      // this is not left with a half-built copy hanging off the page.
      const parent = this.element.parentElement;

      if (parent === null) {
        throw new PageFlipError(
          'Cannot flip a page whose element is not in the document',
          'DETACHED_PAGE',
        );
      }

      this.copiedElement = this.element.cloneNode(true) as HTMLElement;
      this.copiedElement.style.backgroundColor = foldFill(this.render.getSettings().pageBackground);

      // RB6. `cloneNode(true)` duplicates the CONSUMER's subtree into the live
      // document for the length of a turn: their ids, their ARIA, their test
      // ids, and — the part that actually hurts — their focusable controls. A
      // screen reader read the page twice and a Tab press could land inside a
      // decoration that is about to be deleted.
      //
      // The clone exists for one reason: to show the leaf's front face while
      // the original shows something else. It is pixels, nothing more, so it is
      // removed from the accessibility tree AND from the focus/interaction
      // model. `inert` is the platform's exact primitive for that pairing;
      // `aria-hidden` on its own would leave the worst of both worlds — content
      // a keyboard can reach but a screen reader cannot describe.
      //
      // What is deliberately NOT done: the ids are left alone. The clone has to
      // LOOK identical, and `#id` selectors are a normal way for a consumer to
      // style a page; stripping ids would silently restyle the fold. The
      // duplicates are harmless here because both `getElementById` and IDREF
      // resolution (`for`, `aria-labelledby`) take the FIRST match in tree
      // order, and the clone is appended after the original — so every lookup
      // still resolves to the real page. `data-stf-clone` is the marker to
      // filter on when a duplicate would otherwise be ambiguous (a strict-mode
      // `getByTestId`, say).
      this.copiedElement.style.pointerEvents = 'none';
      this.copiedElement.setAttribute('aria-hidden', 'true');
      this.copiedElement.setAttribute('inert', '');
      this.copiedElement.setAttribute('data-stf-clone', '');

      // Media state is not an attribute. A cloned <video>/<audio> is a second
      // player, and a cloned <iframe>/<embed>/<object> a second document.
      // Silence the copies, show a <video> as a canvas of what the page shows,
      // and box the rest. A cloned <canvas> is not repainted (unsupported).
      // Never pause, seek, or reload the original.
      freezeCloneMedia(this.element, this.copiedElement);

      parent.appendChild(this.copiedElement);

      const copy = new Page(this.render, this.copiedElement, this.nowDrawingDensity);
      copy.isTemporaryCopy = true;
      copy.copyOwner = this;

      this.temporaryCopy = copy;
    }

    return this.temporaryCopy;
  }

  public getTemporaryCopy(): Page | null {
    return this.temporaryCopy;
  }

  /**
   * Owner leaf of a temporary copy, or `null` when this is not a copy.
   * @internal Render delta-clear (B3.2) — not part of the published surface.
   */
  public getCopyOwner(): Page | null {
    return this.copyOwner;
  }

  public hideTemporaryCopy(): void {
    if (this.temporaryCopy !== null) {
      this.copiedElement?.remove();
      this.copiedElement = null;
      this.temporaryCopy = null;
    }
  }

  public draw(tempDensity?: PageDensity): void {
    const density = tempDensity ?? this.nowDrawingDensity;

    const pagePos = this.render.convertToGlobal(this.state.position) ?? { x: 0, y: 0 };
    const pageWidth = this.render.getRect().pageWidth;
    const pageHeight = this.render.getRect().height;

    removeClass(this.element, '--simple');

    // The clone must not swallow input. `inert` already says so, but hit
    // testing is the half that matters to this engine: `UI.checkTarget` walks
    // up from `event.target`, so a cloned `<a>`/`<button>` under the finger
    // would suppress the drag (and, without `inert`, could be activated).
    // `pointer-events:none` lets the hit test fall through to the real leaf, so
    // a pointer landing on the fold still starts a turn. It is set once at
    // clone time (for the gap before the first frame) and re-emitted here,
    // because `draw()` replaces `cssText` wholesale on every frame — setting it
    // only at clone time would last exactly one frame.
    // X8. `draw()` replaces `cssText` wholesale, so the z-index the render
    // stamped on this element moments ago has to be re-emitted or the wipe
    // would drop it. But a leaf that has NO inline z-index reads back `''`, and
    // interpolating that produced the literal declaration `z-index:;` — invalid
    // CSS, written on every frame of every draw. The CSSOM discards exactly
    // that declaration and keeps the rest, so it costs nothing today; it is
    // still a malformed token emitted 60×/second, and "the parser throws it
    // away for us" is not a property worth depending on. Omit the declaration
    // when there is no value, rather than emitting an empty one.
    const zIndex = this.element.style.zIndex;
    const zIndexStyle = zIndex === '' ? '' : `z-index:${zIndex};`;

    // Y4. `position:absolute` is stated INLINE, exactly as `simpleDraw` does.
    // It used to be left to `.stf__item{position:absolute}` in the injected
    // stylesheet, so a drawn leaf's positioning was the only part of its layout
    // a consumer rule could take away: `#book .page{position:relative}` — an
    // ordinary rule, and more specific than a single class — un-positioned the
    // FLIPPING leaf while the static ones, which state it inline, stayed put.
    // The fold dropped out of the book mid-turn.
    //
    // Inline rather than a more specific selector in `styles.ts`: the stylesheet
    // ships as `@gullabs/flipbook-core/style.css`, so its selectors are public
    // surface and changing them is a consumer-visible change (§5) — and it would
    // only move the arms race, since any id selector out-specifies any chain of
    // classes. An inline declaration beats every author rule short of
    // `!important`, and `cssText` is not public surface. It also makes the two
    // draw paths agree, which is what made this asymmetry survivable.
    const commonStyle = `position:absolute;${zIndexStyle}left:0;top:0;width:${pageWidth}px;height:${pageHeight}px;${this.isTemporaryCopy ? 'pointer-events:none;' : ''}`;

    addClass(this.element, '--shown');

    if (density === PageDensity.HARD) {
      this.drawHard(commonStyle);
    } else {
      this.drawSoft(pagePos, commonStyle);
    }
  }

  private drawHard(commonStyle = ''): void {
    const rect = this.render.getRect();

    // The spine in block coordinates. The element itself is laid out at
    // left:0 with width = pageWidth, so every hard page has to be translated
    // into place and rotated about the spine.
    //
    // `transform-origin` is expressed in the element's own (untranslated) box
    // and travels with the translation, so the rotation axis ends up at
    //   translateX + originX
    // and that sum has to equal the spine for both orientations:
    //   RIGHT: origin 0            → translateX = spine
    //   LEFT:  origin pageWidth    → translateX = spine - pageWidth
    // which also puts the left page's right edge exactly on the spine.
    //
    // Upstream anchored LEFT at origin `pageWidth` with no translation, i.e.
    // an axis at block-local pageWidth. That equals the spine only when
    // rect.left === 0 (a book filling its block); with `size: 'stretch'` +
    // maxWidth, rect.left is routinely non-zero and the cover rotated about
    // the wrong axis and drew in the wrong place.
    const spine = rect.left + rect.width / 2;

    // H6, the vertical half of the same bug. `commonStyle` pins the element at
    // `top:0` in the block, but the book is centred in the block:
    // `rect.top = blockHeight / 2 - pageHeight / 2`. Soft pages pick that up —
    // `convertPageToGlobal` adds `rect.top` to y, and `simpleDraw` writes
    // `top:${rect.top}` — so a hard page translated by y = 0 sits `rect.top`
    // pixels ABOVE every other leaf. With `size: 'stretch'` (or any fixed book
    // in a taller host) that is a visible jump the instant the cover starts
    // turning. Translate by `rect.top` so the hard element's box coincides with
    // the soft one; the rotation is about Y, so the origin's y component is
    // irrelevant to the axis and stays 0.
    const top = rect.top;

    const angle = this.state.hardDrawingAngle;

    const transform =
      this.orientation === PageOrientation.LEFT
        ? `transform-origin:${rect.pageWidth}px 0;transform:translate3d(${spine - rect.pageWidth}px,${top}px,0) rotateY(${angle}deg);`
        : `transform-origin:0 0;transform:translate3d(${spine}px,${top}px,0) rotateY(${angle}deg);`;

    this.applyEngineStyle(
      `${commonStyle}backface-visibility:hidden;-webkit-backface-visibility:hidden;` +
        `clip-path:none;-webkit-clip-path:none;${transform}`,
      this.render.getSettings().pageBackground,
    );
  }

  private drawSoft(position: Point, commonStyle = ''): void {
    const vertices: string[] = [];

    for (const p of this.state.area) {
      if (p !== null) {
        let g =
          this.render.getDirection() === FlipDirection.BACK
            ? {
                x: -p.x + this.state.position.x,
                y: p.y - this.state.position.y,
              }
            : {
                x: p.x - this.state.position.x,
                y: p.y - this.state.position.y,
              };

        g = rotatePoint(g, { x: 0, y: 0 }, this.state.angle);
        vertices.push(`${g.x}px ${g.y}px`);
      }
    }

    // U7. The polygon used to be built by appending `"x y, "` and then
    // `slice(0, -2)`. With no non-null points in `state.area` that leaves the
    // literal string `polygon)` — invalid CSS, which the browser DROPS. A
    // dropped `clip-path` is not "no fold": it is NO CLIP, so the flipping leaf
    // paints as a full opaque rectangle across the spread for that frame. That
    // is the worst available outcome, and it is the one with no guard.
    //
    // Fewer than three vertices cannot enclose any area, so the correct
    // rendering of such a frame is nothing at all. The two alternatives were
    // rejected: falling back to the page rect is the bug restated, and keeping
    // the previous frame's clip leaves a fold hanging in a shape the state no
    // longer describes (and needs per-page history to do it). A valid,
    // zero-area polygon says exactly what is true — this leaf covers nothing
    // this frame — with no state and no chance of the browser dropping it.
    const polygon =
      vertices.length >= 3
        ? `polygon( ${vertices.join(', ')})`
        : 'polygon(0px 0px, 0px 0px, 0px 0px)';

    // Safari drops the clip-path on a 3d-transformed element at angle 0.
    // https://bugs.webkit.org/show_bug.cgi?id=126207
    // Safari drops clip-path on a 3d-transformed element at angle 0 (webkit#126207).
    const transform =
      this.render.isSafari() && this.state.angle === 0
        ? `transform:translate(${position.x}px,${position.y}px);`
        : `transform:translate3d(${position.x}px,${position.y}px,0) rotate(${this.state.angle}rad);`;

    this.applyEngineStyle(
      `${commonStyle}transform-origin:0 0;clip-path:${polygon};-webkit-clip-path:${polygon};${transform}`,
      this.render.getSettings().pageBackground,
    );
  }

  public simpleDraw(orient: PageOrientation): void {
    const rect = this.render.getRect();
    const pageWidth = rect.pageWidth;
    const pageHeight = rect.height;
    const x = orient === PageOrientation.RIGHT ? rect.left + rect.pageWidth : rect.left;
    const y = rect.top;

    addClass(this.element, '--simple');
    addClass(this.element, '--shown');
    // Static pages are opaque too: a transparent leaf lets the page under
    // the fold read through at the start / end of a turn.
    this.applyEngineStyle(
      `position:absolute;height:${pageHeight}px;left:${x}px;top:${y}px;` +
        `width:${pageWidth}px;` +
        `z-index:${this.render.getSettings().startZIndex + 1};`,
      this.render.getSettings().pageBackground,
    );
  }

  /**
   * Apply the engine's declarations without disturbing the consumer's.
   *
   * Parses rather than taking an object because the draw paths compose their
   * declarations as strings and several are conditional; converting all three to
   * property maps would be a much larger change to the hot path for the same
   * result. The parse is ~15 declarations on at most four leaves per frame.
   *
   * B3.1: skip the DOM write when css + background match the last stamp on
   * this leaf. Invalidation is the other half of correctness — see
   * {@link invalidateDrawCache}.
   */
  private applyEngineStyle(css: string, background?: string): void {
    if (this.lastEngineCss === css && this.lastBackground === background) {
      return;
    }

    const element = this.element;
    const next = new Map<string, string>();

    for (const declaration of css.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon <= 0) continue;

      const property = declaration.slice(0, colon).trim();
      if (property !== '') next.set(property, declaration.slice(colon + 1).trim());
    }

    // Clear only what the engine itself may have written on an earlier frame.
    for (const property of ENGINE_STYLE_PROPS) {
      if (!next.has(property)) element.style.removeProperty(property);
    }

    for (const [property, value] of next) element.style.setProperty(property, value);

    // The BACKGROUND is applied separately, never through the parsed string.
    //
    // It is the one declaration whose value comes from consumer input, and this
    // function splits on `;` — so embedding it made a semicolon in the colour a
    // second declaration. The settings boundary rejects `;` and `foldFill`
    // rejects it again at draw, so it could not actually inject; but a rule that
    // holds only because two other checks happen to be right is the wrong shape
    // for the one value an attacker controls. Passing it as its own argument
    // removes the class of bug rather than guarding it.
    // The paper is stamped ON THE ELEMENT ITSELF, as the same structural pair
    // the `::before` layer uses: an opaque `#fff` base with the consumer's
    // `--stf-paper` composited over it as an image layer. The value still
    // travels only through the custom property — the gradient references
    // `var(--stf-paper)`, so no consumer input is ever interpolated into a
    // declaration string.
    //
    // Why the element and not only the pseudo (consumer report, Puddlebend
    // Issue 1): the fold puts `transform` + `clip-path` on this element, and a
    // root whose only opacity lives on a `z-index:-1` pseudo is fragile against
    // compositor behavior — measured in landscape as a band at the fold line
    // where the turning page alpha-blended with the leaf beneath. Painting the
    // transformed element itself is the guarantee; the pseudo stays as the
    // backstop (and as the paint for any state the engine has not drawn).
    //
    // This does NOT change which colour a consumer sees: every drawn leaf
    // carries an inline z-index (and the stylesheet's `preserve-3d`), so the
    // leaf is a stacking context and the negative-z pseudo already painted
    // ABOVE the root's own background. Per-page colour goes through
    // `pageBackground` / `--stf-paper`, or on an inner element — the root's
    // background has always lost to the paper in a drawn state.
    //
    // The same pair also covers replaced-element roots (`img`, `video`,
    // `canvas`, `iframe`, `embed`), where pseudo-elements never render — the
    // inline write is the only opaque backing such a root can have.
    // foldFill AFTER the memo check: jsdom's CSS.supports (used inside
    // foldFill) writes setProperty/cssText on a throwaway element, which would
    // defeat the per-frame write budget on every cache hit.
    if (background !== undefined) {
      const fill = foldFill(background);
      element.style.setProperty('--stf-paper', fill);
      element.style.setProperty('background-color', '#fff');
      element.style.setProperty(
        'background-image',
        'linear-gradient(var(--stf-paper,#fff),var(--stf-paper,#fff))',
      );
    }

    this.lastEngineCss = css;
    this.lastBackground = background;
  }

  /**
   * Drop the memoized engine-style stamp so the next draw rewrites the DOM.
   *
   * Called from density/orientation setters, UI adopt/release, and collection
   * `invalidateDrawCache()` (Render.update / reload). Also walks the temporary
   * copy — it is not in the collection.
   *
   * @internal
   */
  public invalidateDrawCache(): void {
    this.lastEngineCss = null;
    this.lastBackground = undefined;
    this.temporaryCopy?.invalidateDrawCache();
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * H7. Nothing to do: an HTML leaf is its element, and the element exists
   * before the page does. `ImagePage.load()` decodes a bitmap and its `isLoad`
   * genuinely gates drawing; this class carried a field of the same name that
   * was written here and read nowhere, which reads like a gate and is not one.
   * The method stays because collections still call `load()`; the field is gone.
   */
  public load(): void {
    //
  }

  /**
   * Set page orientation
   *
   * @param {PageOrientation} orientation
   */
  public setOrientation(orientation: PageOrientation): void {
    this.orientation = orientation;
    this.element.classList.remove('--left', '--right');

    this.element.classList.add(orientation === PageOrientation.RIGHT ? '--right' : '--left');
    // Class change changes what the next draw means — bust the style memo.
    this.invalidateDrawCache();
  }

  /**
   * Set temp page density to next render
   *
   * @param {PageDensity}  density
   */
  public setDrawingDensity(density: PageDensity): void {
    this.element.classList.remove('--soft', '--hard');
    this.element.classList.add(`--${density}`);

    this.nowDrawingDensity = density;
    this.invalidateDrawCache();
  }

  /**
   * NF1. The class follows the density, and it only did for ONE of the two
   * setters.
   *
   * `setDrawingDensity` above syncs it; `setDensity` — which writes the page's
   * PERMANENT density and is what `PageCollection.createSpread` calls to make a
   * cover hard — did not. So an engine-inferred cover ended up
   * `getDensity() === 'hard'` while its element still read
   * `class="stf__item --soft"`. Consumer CSS written against `.stf__item.--hard`
   * therefore never matched a cover, and `--soft` matched a leaf the engine
   * draws through `drawHard` — the class asserted the opposite of the truth.
   *
   * Safe to overwrite, because this class is engine OUTPUT and not input: the
   * density a consumer DECLARES is `data-density="hard"`, which
   * `PageCollection.load` reads, and nothing anywhere reads `--hard` back.
   * A consumer who styles against it is reading a value the engine publishes,
   * so publishing the true one is the fix rather than the risk.
   *
   * It is also only safe to do now. Until `updateFromHtml` was reordered to
   * adopt before loading (NF2), `UI.adopt` snapshotted its "pre-existing
   * engine classes" AFTER the engine had already stamped them — so a class
   * written here would have been recorded as the consumer's and left behind on
   * their element forever.
   */
  public setDensity(density: PageDensity): void {
    this.createdDensity = density;
    this.nowDrawingDensity = density;

    this.element.classList.remove('--soft', '--hard');
    this.element.classList.add(`--${density}`);
    this.invalidateDrawCache();
  }
  /**
   * Set page position
   *
   * @param {Point} pagePos
   */
  public setPosition(pagePos: Point): void {
    this.state.position = pagePos;
  }

  /**
   * Set page angle
   *
   * @param {number} angle
   */
  public setAngle(angle: number): void {
    this.state.angle = angle;
  }

  /**
   * Set page crop area
   *
   * @param {Point[]} area
   */
  public setArea(area: (Point | null)[]): void {
    this.state.area = area;
  }

  /**
   * Rotate angle for hard pages to next render
   *
   * @param {number} angle
   */
  public setHardDrawingAngle(angle: number): void {
    this.state.hardDrawingAngle = angle;
  }

  /**
   * Rotate angle for hard pages
   *
   * @param {number} angle
   */
  public setHardAngle(angle: number): void {
    this.state.hardAngle = angle;
    this.state.hardDrawingAngle = angle;
  }

  /**
   * Get temp page density
   */
  public getDrawingDensity(): PageDensity {
    return this.nowDrawingDensity;
  }

  /**
   * Get a constant page density
   */
  public getDensity(): PageDensity {
    return this.createdDensity;
  }

  /**
   * Get rotate angle for hard pages
   */
  public getHardAngle(): number {
    return this.state.hardAngle;
  }

  /**
   * Release anything the page owns beyond its own object graph.
   *
   * An HTML leaf borrows a node the host owns; dispose only hides the temporary
   * copy created for a soft turn.
   */
  public dispose(): void {
    this.hideTemporaryCopy();
  }
}

/** Elements whose copy would be a second player or a second document. */
const LIVE_EMBEDS = 'video,audio,iframe,embed,object';

/**
 * One pass over the clone, paired by document order with the original (the
 * clone is a synchronous `cloneNode(true)`, so the two lists line up). Runs
 * while the clone is still detached: an `<iframe>` / `<embed>` / `<object>`
 * only loads once it is inserted, so replacing it here means it never does.
 * A media element is different — `cloneNode` copies `src`, and that alone
 * starts a fetch (and, with `autoplay`, playback) on a detached copy, which
 * `replaceWith` / `remove` do not stop. `silence` aborts it.
 *
 * Never touches the original: no `currentTime`, `pause`, or `load`.
 */
function freezeCloneMedia(original: HTMLElement, clone: HTMLElement): void {
  const sources = original.querySelectorAll<HTMLElement>(LIVE_EMBEDS);
  if (sources.length === 0) return;
  const copies = clone.querySelectorAll<HTMLElement>(LIVE_EMBEDS);

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const copy = copies[i];
    if (source === undefined || copy === undefined) continue;

    if (copy instanceof HTMLMediaElement) silence(copy);

    // Audio is boxed like an embed, not removed: `<audio controls>` has a
    // box, and removing it collapsed the fold's layout (a hidden one resolves
    // to `display: none` and still takes no room).
    copy.replaceWith(
      source instanceof HTMLVideoElement
        ? frameOf(source)
        : standIn(source, 'div', 'data-stf-embed'),
    );
  }
}

/** Abort the load the copied `src` started, and keep the copy from playing. */
function silence(copy: HTMLMediaElement): void {
  copy.removeAttribute('autoplay');
  copy.removeAttribute('src');
  for (const source of Array.from(copy.querySelectorAll('source'))) source.remove();
  copy.load();
}

/**
 * An inert box that takes `source`'s place in the page's layout. It carries
 * every attribute (so the host's `data-*` survive — PB-11 G1) except `width` /
 * `height`, which on a canvas would size the backing store, AND the source's
 * whole resolved style inline. Rules written against the tag
 * (`.bg video { position: absolute; inset: 0 }`) do not match a `<canvas>` or a
 * `<div>`, so without the resolved style a full-bleed loop dropped into flow
 * and pushed the page's text off the fold. The copy is a snapshot for one
 * turn, so resolved values (`width: 332px`) are exactly what it should keep.
 */
function standIn<K extends 'canvas' | 'div'>(
  source: HTMLElement,
  tag: K,
  marker: string,
  computed: CSSStyleDeclaration = getComputedStyle(source),
): HTMLElementTagNameMap[K] {
  const box = document.createElement(tag);
  for (const { name, value } of Array.from(source.attributes)) {
    if (name !== 'width' && name !== 'height') box.setAttribute(name, value);
  }
  box.setAttribute(marker, '');

  const style = box.style;
  for (let i = 0; i < computed.length; i++) {
    const name = computed.item(i);
    style.setProperty(name, computed.getPropertyValue(name));
  }
  // An inline replaced element sizes like `inline-block`; a `div` left
  // `inline` would ignore the width and height it was just given.
  if (computed.display === 'inline') style.display = 'inline-block';
  return box;
}

/**
 * The video as the page shows it. Before the first frame is played the page
 * shows the poster (the HTML "show poster" state), so the copy paints that;
 * otherwise it paints the current frame. The backing store keeps the video's
 * aspect ratio, so the resolved `object-fit` / `object-position` crop and
 * letterbox exactly as the `<video>` did, and for the scaling fits it is capped
 * at the box times the device pixel ratio: a 4K frame used to allocate ~33 MB.
 * `none` and `scale-down` draw the frame at its intrinsic size, so those keep
 * the native resolution.
 */
function frameOf(source: HTMLVideoElement): HTMLCanvasElement {
  const computed = getComputedStyle(source);
  const box = standIn(source, 'canvas', 'data-stf-frame', computed);
  const fit = computed.objectFit;
  const poster = source.poster;

  if (poster !== '' && source.played.length === 0 && source.currentTime === 0) {
    box.setAttribute('data-stf-poster', poster);
    // The original is displaying this URL, so it is a cache hit, not the
    // second request the copy exists to avoid. Longhands, so a host
    // background-color survives.
    const style = box.style;
    style.backgroundImage = `url(${JSON.stringify(poster)})`;
    style.backgroundPosition = computed.objectPosition;
    style.backgroundSize =
      fit === 'fill'
        ? '100% 100%'
        : fit === 'none'
          ? 'auto'
          : fit === 'cover'
            ? 'cover'
            : 'contain';
    style.backgroundRepeat = 'no-repeat';
    return box;
  }

  const width = parseFloat(computed.width);
  const height = parseFloat(computed.height);
  const frameWidth = source.videoWidth;
  const frameHeight = source.videoHeight;
  const ctx =
    source.readyState >= 2 && frameWidth > 0 && frameHeight > 0 && width > 0 && height > 0
      ? box.getContext('2d')
      : null;
  if (ctx === null) return box;

  const scale =
    fit === 'none' || fit === 'scale-down'
      ? 1
      : Math.min(
          1,
          Math.max(width / frameWidth, height / frameHeight) * (window.devicePixelRatio || 1),
        );
  box.width = Math.max(1, Math.round(frameWidth * scale));
  box.height = Math.max(1, Math.round(frameHeight * scale));
  // `drawImage` on a video does not throw for readiness or for a cross-origin
  // source (that only taints the canvas); guarded anyway, because a throw here
  // would escape a pointer handler mid-turn.
  try {
    ctx.drawImage(source, 0, 0, box.width, box.height);
  } catch {
    // A blank box still makes no request.
  }
  return box;
}
