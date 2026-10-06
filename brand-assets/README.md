# Official brand references

The 11 small logos here are identification references collected on 2026-10-06 from each brand's public official site / media page. Exact page and asset URLs, download hashes and foreground bounds are recorded in `sources.json` and `provenance.json`. Brand marks remain the property of their respective owners; these references do not imply affiliation, endorsement or a trademark licence.

`scripts/build-brand-logos.mjs` removes flat background padding and creates small transparent references and locally bundled features. Original downloads are kept in the local output directory, not redistributed as a media library. Rebuild with `node scripts/build-brand-logos.mjs`; `--offline` uses the previously downloaded originals.

The runtime does not contact official sites. Matching is restricted to the vicinity of confirmed corner text of the same brand. These website logos do not exhaust the different photo-watermark versions, opacity, fonts or layout variants used by these platforms. OCR, position, size, template confidence and the maximum crop-strip guard must still pass; unknown centre watermarks or logo-only cases remain manual.
