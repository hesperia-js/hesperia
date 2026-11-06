# Vendored Saxe maintenance

Hesperia maintains a private copy of `@federicocarboni/saxe@0.8.0` for
standalone SVG imports.

## Provenance and license

The audited [npm package metadata](https://registry.npmjs.org/@federicocarboni%2Fsaxe/0.8.0)
identifies version `0.8.0`. Its published tarball is available at
[`saxe-0.8.0.tgz`](https://registry.npmjs.org/@federicocarboni/saxe/-/saxe-0.8.0.tgz)
with integrity `sha512-l3KPI+js9P3blZUxTxWOIDzMbsedfnRwYBzuKSG5RbsYRAJF0tOmbK9pmi4+s+7wGiv4BkjseyWYLLm3YRCThw==`
and SHA-256 `c03c8dc8ba504a6da0c479330d7fd6cce4dd706ea543169a60d0dca40fa7e0d8`.

All six TypeScript inputs embedded in the audited package's source map match the
files at upstream commit
[`d48e96df761055d7d81eccb82353c744eca82c8c`](https://github.com/federicocarboni/saxe/commit/d48e96df761055d7d81eccb82353c744eca82c8c)
byte for byte. That commit records package version `0.8.0`; its tree is
`b45bb9f2671dcea1d1536b9a78d9f238b7c7273d`. The GitHub source archive for that
commit has SHA-256
`58622f54811609b99796828183e72bde986399432c45fe29550b4c881762d200`.

The published package's build metadata describes TypeScript compilation and
esbuild bundling with a source map. Hesperia did not independently rebuild that
bundle, so this provenance does not claim reproducible-build equivalence or
independent validation of source-map semantics.

Saxe is licensed under Apache-2.0 and identifies Federico Carboni as its author.
The complete upstream license is retained in the source tree and in the
shipped documentation at [vendor/saxe/LICENSE](vendor/saxe/LICENSE). The
upstream package and source archive contain no `NOTICE` file.

## Local changes

`parser.ts` is specialized for DTD-prohibited operation and counts decoded
logical text runs after XML newline normalization. `namespace.ts` removes an
unused DTD QName hook while retaining namespace-aware name validation. Both
modified files carry Hesperia change notices. The other four TypeScript modules
retain the upstream baseline.

The parser and its options are internal to tooling. When updating the vendor,
retain the license and notices and verify checked SVG import behavior through
its public owner. Historical coverage captures do not qualify a new source tree.
