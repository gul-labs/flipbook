/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

/**
 * Allowlist of `public` members on the façade and on types still named in
 * internal source. Adding any `public` member fails until it is reviewed onto
 * this list (see `src/internal.ts` stopping rule).
 *
 * `getUI` / `getRender` / `getPageCollection` / `getFlipController` /
 * `getPage` were collapsed into façade answers (`getBlockElement`,
 * `getVisiblePages`, `canTurn`, `isReady`, `isAnimating`, `getPageElement`)
 * and symbol-keyed seams. They must not reappear as `public` names.
 */

interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string;
}
interface NodeProcess {
  cwd(): string;
}

const loadNode = async <T>(specifier: string): Promise<T> =>
  (await import(/* @vite-ignore */ specifier)) as T;

const fs = await loadNode<NodeFs>('node:fs');
const proc = (globalThis as unknown as { process: NodeProcess }).process;
const SRC = `${proc.cwd()}/packages/core/src`;

function publicMembers(relativePath: string): string[] {
  const source = fs.readFileSync(`${SRC}/${relativePath}`, 'utf8');

  return [...source.matchAll(/^ {2}public (?:readonly )?(\[?[A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1] as string)
    .filter((name) => !name.startsWith('['))
    .sort();
}

describe('the engine public surface is frozen', () => {
  test('PageFlip — consumer façade only', () => {
    expect(publicMembers('PageFlip.ts')).toEqual(
      [
        'canTurn',
        'cancelTurn',
        'clear',
        'destroy',
        'flipToPage',
        'flipNext',
        'flipPrev',
        'getBlockElement',
        'getBoundsRect',
        'getCurrentPageIndex',
        'getOrientation',
        'getPageCount',
        'getPageElement',
        'getSettings',
        'getState',
        'getVisiblePages',
        'isAnimating',
        'isDestroyed',
        'isReady',
        'loadFromHTML',
        'startUserTouch',
        'turnToNextPage',
        'turnToPage',
        'turnToPrevPage',
        'update',
        'updateFromHtml',
        'updateSettings',
        'userMove',
        'userStop',
      ].sort(),
    );
  });

  test('closed getters stay off the public list', () => {
    const names = publicMembers('PageFlip.ts');
    for (const closed of [
      'getUI',
      'getRender',
      'getPageCollection',
      'getFlipController',
      'getPage',
      'loadFromImages',
      'updateFromImages',
      // C7 — load/attach wiring is symbol-keyed; public names must not return.
      'attachMode',
      'replacePages',
      'getBlock',
    ]) {
      expect(names).not.toContain(closed);
    }
  });

  test('C7 — attach/replace/getBlock live only as symbol methods in source', () => {
    // Revert-blocker for 5480ebe: if someone re-publishes these as plain
    // `public attachMode(...)` the publicMembers allowlist above catches the
    // name, and this catches a half-migration that keeps the string name in a
    // different form (`public attachMode` without the method paren match, or a
    // re-export). The symbols themselves stay — that is the designed seam.
    const source = fs.readFileSync(`${SRC}/PageFlip.ts`, 'utf8');
    expect(source).toMatch(/public \[ATTACH_MODE\]/);
    expect(source).toMatch(/public \[REPLACE_PAGES\]/);
    expect(source).toMatch(/public \[GET_BLOCK\]/);
    expect(source).not.toMatch(/^ {2}public attachMode\b/m);
    expect(source).not.toMatch(/^ {2}public replacePages\b/m);
    expect(source).not.toMatch(/^ {2}public getBlock\(/m);
  });

  test('UI — only reachable via closed GET_UI seam', () => {
    // Collapsed from UI + HTMLUI (Campaign A1): clear/update/updateItems moved
    // onto the concrete class; `abstract` is gone.
    expect(publicMembers('UI/UI.ts')).toEqual(
      [
        'applyHostSize',
        'clear',
        'destroy',
        'getDistElement',
        'getWrapper',
        'refreshHandlers',
        'update',
        'updateItems',
      ].sort(),
    );
  });

  test('UI collapse — former subclass seam members stay private, not protected', () => {
    // Codex A1 signoff: publicMembers only sees `public`, so reverting these
    // six to `protected` would still green-pass the allowlist above. Pin the
    // visibility keyword itself — the inheritance seam must stay closed.
    const source = fs.readFileSync(`${SRC}/UI/UI.ts`, 'utf8');
    for (const name of [
      'parentElement',
      'app',
      'wrapper',
      'distElement',
      'removeHandlers',
      'setHandlers',
    ]) {
      expect(source).toMatch(new RegExp(`^ {2}private(?: readonly)? ${name}\\b`, 'm'));
      expect(source).not.toMatch(new RegExp(`^ {2}protected(?: readonly)? ${name}\\b`, 'm'));
    }
  });

  test('Render collapse — former subclass seam fields stay private, not protected', () => {
    // A3 audit follow-up (mirrors the A1 pin above): the twelve state fields
    // inherited from the abstract era serve no subclass — TestRender and
    // ProbeRender override only drawFrame/reload and call requestFrame.
    // `drawFrame`, `reload`, `requestFrame` and `needsContinuousFrames` stay
    // protected on purpose; the FIELDS are the closed seam.
    const source = fs.readFileSync(`${SRC}/Render/Render.ts`, 'utf8');
    for (const name of [
      'setting',
      'app',
      'leftPage',
      'rightPage',
      'flippingPage',
      'bottomPage',
      'direction',
      'orientation',
      'shadow',
      'animation',
      'pageRect',
      'timer',
    ]) {
      expect(source).toMatch(new RegExp(`^ {2}private(?: readonly)? ${name}\\b`, 'm'));
      expect(source).not.toMatch(new RegExp(`^ {2}protected(?: readonly)? ${name}\\b`, 'm'));
    }
  });

  test('PageCollection — only reachable via closed GET_COLLECTION seam', () => {
    expect(publicMembers('Collection/PageCollection.ts')).toEqual(
      [
        'destroy',
        'getBottomPage',
        'getCurrentPageIndex',
        'getCurrentSpreadIndex',
        'getFlippingPage',
        'getPage',
        'getPageCount',
        'getPages',
        'getSpreadCount',
        'getSpreadIndexByPage',
        'invalidateDrawCache',
        'load',
        'nextBy',
        'prevBy',
        'show',
        'showNext',
        'showPrev',
      ].sort(),
    );
  });
});

describe('package entry does not re-export internals', () => {
  test('Settings class and geometry helpers are not on the public entry', async () => {
    const core = await import('@gullabs/flipbook-core');
    expect(core).not.toHaveProperty('Settings');
    expect(core).not.toHaveProperty('isOpaquePageBackground');
    expect(core).not.toHaveProperty('effectiveFlippingTime');
    expect(core).not.toHaveProperty('HTMLPageCollection');
    expect(core).not.toHaveProperty('Render');
    expect(core).not.toHaveProperty('Flip');
    expect(core).toHaveProperty('PageFlip');
    expect(core).toHaveProperty('PageFlipError');
    expect(core).toHaveProperty('SizeMode');
    expect(core).toHaveProperty('ALL_POINTERS');
    expect(core).toHaveProperty('FlipCorner');
    expect(core).toHaveProperty('FlippingState');
  });
});
