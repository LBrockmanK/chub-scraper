# SVG on Chub Cards — Measurement and Decision

**Outcome: no work was done, deliberately.** This record exists so the question does not get
re-derived, and so nobody builds the rasterizer.

## The reported symptom

SVG images scraped from Chub cards never reach the SillyTavern gallery. They are discovered,
downloaded, uploaded, rejected, and counted in `failed` with no explanation.

## Why, stated correctly

SillyTavern's `MEDIA_EXTENSIONS` allowlist in `src/constants.js` has no `svg` entry, and
`POST /api/images/upload` validates its `format` field against that list. The upload is rejected.
That is the whole mechanism.

`POST /api/images/list` is **not** involved. It filters by mime category via a `type` bitflag, not by
`MEDIA_EXTENSIONS` — see the `ST_MEDIA_EXTENSIONS` and `VIDEO_EXTENSIONS` comments in `lib.js` and
commit `128eb10`. An earlier draft of this note claimed both endpoints gated on the same list; that
was wrong, and the same mistake previously caused a real bug in the AVIF work, where converted
`.webm` files went missing from the listing that cross-run dedup depends on.

## What SVGs on Chub actually are

Measured against the live Chub API. The extraction regexes from `lib.js` were ported verbatim so the
counts reflect what the extension would really pick up.

| Sample | Cards | Extractable SVG URLs |
| --- | --- | --- |
| Random, search-provided descriptions | 2689 | 0 |
| Random, `full=true` — description + `first_message` + all `alternate_greetings`, including every image-rich card in the pool | 250 | 0 |
| Adversarial — cards found by searching `svg`, `.svg`, `svgrepo`, `shields.io`, `image/svg` | ~220 | 31 |

Search-provided descriptions are truncated for roughly a third of cards (86 of 250 measured), so only
the `full=true` pass is authoritative for absence. It also found zero.

Every one of the 31 adversarial hits is a third-party badge:

- `https://ko-fi.com/img/githubbutton_sm.svg` — a Ko-fi donate button, 28 hits, nearly all from one
  creator repeating the same footer across their catalogue.
- `https://discord.com/assets/{hash}.svg` — Discord UI icons, 3 hits on one card.

None is character artwork. Finding any at all required searching for the format by name.

Extension histogram across the random sample's extracted URLs: `.png` 258, `.webp` 87, no extension
79, `.jpg` 62, `.jpeg` 36, `.gif` 31, `.css` 3.

Inline `<svg>` markup does appear on cards (9 occurrences in the adversarial pool), but
`extractImagesFromHtml` matches URLs only and never extracts it. That behaviour is already correct.

## Decision

**Do not rasterize SVG to PNG.** It is feasible — the extension already holds the bytes from
`corsFetch`, so a `blob:` URL keeps the canvas same-origin and untainted, and the CORS proxy is
irrelevant to tainting because the image is never loaded cross-origin. Feasibility was never the
binding constraint. The measured population contains zero artwork, so a rasterizer would spend a new
module and a dimension heuristic to reliably deposit other sites' donate buttons into the user's
character gallery.

**Do not build SVG filtering either.** A branch that did this was written and then abandoned: it
dropped `.svg` and `.css` at extraction and added an `unsupported` counter so rejected formats stopped
inflating `failed`. It worked and was reviewed clean, but the measurement is what killed it — the
symptom fires only on cards carrying a creator's donate-button footer, costing one `failed` on an
import that otherwise succeeds. Not worth the surface area.

## Adjacent findings, recorded but not acted on

- The `url()` pattern in `extractImagesFromHtml` also matches `@import` targets inside `<style>`
  blocks. Three `.css` URLs were extracted across 2689 cards; each is downloaded and counted `failed`.
  Same shape as the SVG problem and the same verdict.
- `guessExtension`'s URL branch takes `substring(lastIndexOf('.'))` of the whole pathname, so
  `/media/file.webp/a1b49d2a` yields `.webp/a1b49d2a` as its extension candidate. It is latent, not
  live: `IMAGE_EXTENSIONS.has()` rejects the malformed value and the call falls through to magic
  bytes with the correct answer. Worth knowing before someone "fixes" it and changes behaviour.

## If this is revisited

The thing to re-measure is whether SVG artwork has appeared on Chub, not whether rasterization
works. The sampling method above is the check: pull cards with `full=true` from
`gateway.chub.ai/search`, run the `lib.js` regexes over description, `first_message` and every
`alternate_greetings` entry, and look at what the `.svg` hits actually are. If they are still badges,
the answer is still no.
