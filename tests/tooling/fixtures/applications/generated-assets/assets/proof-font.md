# Proof font fixture

proof.ttf is an original, deterministic TrueType fixture authored for generated-asset browser qualification. It is not copied from a system font and has no font-library build dependency.

The static sfnt uses 1,000 units per em, two glyph IDs (glyph 0 .notdef; glyph 1 a four-point solid contour mapped from U+E000), and a 733-unit advance for glyph 1. At 100 CSS px, the target advance is 73.3 CSS px. Vertical metrics are 800 ascent and -200 descent. It contains the eight required OpenType tables plus glyf and loca, uses no hinting, composite glyphs, variation data, or runtime generation.

SHA-256: 82C7EFE1D8D9F598644B92E8C03489A4240CE60586631F60EB9BFE844E8A9F7F

This is source-fixture metadata only. Font parser/OTS and browser validity remain unrun until qualification. CSS @font-face uses its native anonymous CORS fetch semantics; this fixture does not prove module include credentials.
