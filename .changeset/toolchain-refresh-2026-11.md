---
'@gullabs/flipbook-core': patch
'@gullabs/react-flipbook': patch
---

Rebuilt on a refreshed toolchain (pnpm 12, Node 26 in CI, current dev dependencies). No API or behaviour change: the shipped JavaScript and CSS are byte-identical to 3.2.2. The `.d.ts` files export the same names, but list the type-only ones in a separate `export type { … }` statement (emitted by the newer bundler), and the `devDependencies` recorded in each `package.json` are newer. Release builds now check after publishing that every published version carries an npm provenance attestation.
