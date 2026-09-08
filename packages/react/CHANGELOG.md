# @gullabs/react-flipbook

## 3.2.1

### Patch Changes

- 6361a7c: Docs and tooling hygiene: consumer README/API accuracy, safe Dependabot devDependency bumps (Playwright 1.63, eslint 10.10, etc.). No runtime API change.
- Updated dependencies [6361a7c]
  - @gullabs/flipbook-core@3.2.1

## 3.2.0

### Minor Changes

- b5594c3: Mobile live-HTML: cancel in-flight turns on resize (`cancelTurn`), stamp-then-abandon `updateSettings`, pointer-capture steal handling, and a React `destroy()` handle that retires a still-mounted book.

### Patch Changes

- Updated dependencies [b5594c3]
  - @gullabs/flipbook-core@3.2.0

## 3.1.0

### Minor Changes

- 4c56340: Add `turnProgress` event and React `onTurnProgress` for scrubber/progress UI during animated turns and drags (PLAN-3.1 Campaign C).

  - Core emits `{ progress, direction }` from fold position updates while `USER_FOLD` / `FLIPPING`; silent for instant turns, reduced motion, and hover peels
  - Direction is semantic page-index order (`next` under RTL still means higher indices)
  - No synthetic terminal 1.0/0 — completion remains `flip` / `changeState`
  - React `onTurnProgress` receives the unwrapped payload; changing the handler does not remount

  Also ships the internal 3.1 collapse (Campaign A) and frame-discipline draw-path elision (Campaign B) under the same minor.

  Size: turnProgress spent ~0.58 kB raw headroom; ceilings raised 63→63.5 / 15.5→15.6 / 17.4→17.6 kB (feature may spend headroom, AGENTS.md §2).

### Patch Changes

- Updated dependencies [4c56340]
  - @gullabs/flipbook-core@3.1.0
