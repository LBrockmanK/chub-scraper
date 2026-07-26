# AVIF → WebM Conversion for the Gallery — Design Spec

## Problem

Some Chub cards embed animated AVIF files. SillyTavern renders them fine in chat, but they never
reach the character gallery.

The cause is a server-side allowlist, not a rendering limitation. ST's `src/constants.js` defines:

```
MEDIA_EXTENSIONS = [bmp, png, jpg, webp, jpeg, jfif, gif, mp4, avi, mov, wmv, flv, webm, 3gp, mkv, mpg, mp3, ...]
```

`avif` is absent, and `POST /api/images/upload` validates its `format` field against that list, so
the extension's upload of an AVIF is rejected and lands in the `failed` counter. That alone makes
conversion necessary.

Chat messages bypass the allowlist entirely — they render through a plain `<img>` tag.

**Correction to an earlier draft of this spec.** That draft also claimed `POST /api/images/list`
filters by `MEDIA_EXTENSIONS`, making a hand-placed `.avif` invisible to the gallery. That is wrong.
`/list` gates on **mime category via a `type` bitflag** (`src/util.js` `getImages` checks
`mime.lookup(file).startsWith('image/')` and friends), not on `MEDIA_EXTENSIONS`. ST depends on
`mime-types` v3, whose mime-db maps `avif` → `image/avif`, so `.avif` does pass the listing filter.

Two things follow. First, the originally reported symptom — a manually added `.avif` not appearing —
is not explained by the listing filter, and its real cause remains unconfirmed (a gallery needing a
reopen to re-list, an older ST whose `getImages` filtered by extension, or nanogallery2's thumbnail
handling are all plausible). It does not affect this design, because the upload gate is what blocks
the extension. Second, and more consequentially, believing `/list` gated on `MEDIA_EXTENSIONS`
directly produced a bug during implementation: `getExistingGalleryHashes` requested no `type`, ST
defaulted to images-only, and converted `.webm` files were therefore absent from the listing that
cross-run dedup depends on — so every re-import would have re-converted and re-added every clip, and
because ST's upload overwrites identical paths without disambiguation, could have overwritten them.
See `MEDIA_TYPE_IMAGE_AND_VIDEO` in `index.js`.

## What these files actually are

Measured on `chub.ai/characters/R_Endsa_Q/waking-up-naked-next-to-a-very-happy-elf-...-b2d788175b7d`,
which hosts roughly 15 AVIFs on `waking-up-naked-next-to-a-verry-happy-elf.pages.dev`:

| file | frames | fps | dimensions | bytes |
| --- | --- | --- | --- | --- |
| `Ending_Puppy_24fps.avif` | 131 | 24 | 608×608 | 1.3 MB |
| `G1_Roselle_32FPS_Part1_f0-156.avif` | 157 | 32 | 512×768 | 1.3 MB |
| `Pale man.avif` | 57 | 16 | 640×640 | 0.3 MB |
| `g3.avif` | 167 | 32 | 608×608 | 0.9 MB |
| `PNG_Seq_Part1_f1-163.avif` | 163 | 32 | 608×608 | 1.5 MB |

Every one is animated — these are Wan2.2 i2v video clips shipped in an image container.

This rules out GIF as a conversion target: 131 frames at 608×608 would be tens of megabytes with
256-colour banding. It also rules out animated WebP, which browsers can decode but not encode.

WebM is the right target. `webm` is already in `MEDIA_EXTENSIONS`, and ST's gallery treats video as a
first-class citizen — `public/scripts/extensions/gallery/index.js` calls `getVideoThumbnail()` for the
grid and opens `<video controls autoplay>` on click.

## Feasibility — verified before writing this spec

A throwaway prototype run in Chrome against the real `g3.avif` established:

- `ImageDecoder` decodes animated AVIF frame-by-frame, exposing `frameCount` and per-frame `duration`.
- 167 frames decoded and VP9-encoded in **1.4 s**.
- VP9 emits **no `decoderConfig.description`**, so the container needs no `CodecPrivate` element —
  a material simplification versus H.264 or AV1.
- A hand-written EBML muxer produced a WebM that plays: reported duration 5.21875 s against an
  expected 5218.75 ms, correct 608×608 dimensions, and a mid-seek frame with real image content
  (3894 of 4096 sampled pixels non-blank).

The design below is therefore transcription of a proven path, not speculation.

## Architecture

Three modules, following the repo's existing split between pure logic and browser integration.

### `webm.js` — pure bytes, no browser APIs

EBML primitives and a single-track WebM writer. Node-testable like `lib.js`.

```
vint(n)        — size vint with length descriptor
uint(n)        — big-endian unsigned integer, minimal width
float64(n)     — 8-byte IEEE-754
element(id, payload)
buildWebM({ width, height, frameDurationUs, durationMs, chunks }) → Uint8Array
```

`chunks` is an array of `{ data: Uint8Array, timestampUs: number, key: boolean }`.

Container structure:

```
EBML header       — DocType "webm", DocTypeVersion 2, EBMLMaxIDLength 4, EBMLMaxSizeLength 8
Segment
  Info            — TimecodeScale 1000000 (1 ms), MuxingApp/WritingApp, Duration (float, ms)
  Tracks
    TrackEntry    — TrackNumber 1, TrackUID 1, TrackType 1 (video),
                    CodecID "V_VP9" or "V_VP8", DefaultDuration (ns),
                    Video → PixelWidth, PixelHeight
  Cluster*        — Timecode (ms), then SimpleBlock per frame
```

A new cluster opens at each keyframe, and unconditionally if the relative offset would exceed
30000 ms — SimpleBlock relative timestamps are signed 16-bit and must stay in range. SimpleBlock
payload is track number `0x81`, int16 relative timestamp, flags (`0x80` for keyframe, else `0x00`),
then the frame data.

Note on `vint`: an all-ones size vint is reserved for "unknown size", so a value equal to
`2^(7·len) − 1` must escalate to the next width. Widths above 4 bytes are unreachable in practice
here; the implementation is correct for sizes below 2^49 and the tests document that bound.

### `avif.js` — the browser half

```
isAvifConvertible()        → boolean, cached per session
convertAvif(buffer, onProgress) → { buffer, ext, kind }   // kind: 'video' | 'still'
```

Owns `ImageDecoder`, `VideoEncoder`, and `OffscreenCanvas`. Never throws for a recoverable
condition — it degrades to `kind: 'still'` instead.

### `lib.js` — additions

- The set of extensions ST accepts, mirroring `MEDIA_EXTENSIONS`.
- `needsConversion(ext)` — true for `.avif`. The "what does ST accept" knowledge belongs beside the
  other pure logic rather than inline in the integration layer.

### `index.js` — one insertion point

In `fetchAndImportImages`, between the dedup check and filename generation. Conversion runs *after*
dedup so a re-import never pays for an encode it would discard.

Extension detection must move ahead of the dedup check, because which dedup test applies depends on
whether the file needs converting. The resulting order:

```
download
  → hash(original bytes)
  → guessExtension(url, contentType, buffer)
  → dedup:  needsConversion(ext) ? filename-marker test : content-hash test
  → [if needsConversion(ext): convert, which may change ext to .webm or .png]
  → filename
  → base64
  → upload
```

Batch-level dedup (the same image appearing twice in one run) continues to use the original-bytes
hash in `batchHashes`, which is correct for both paths.

## Dedup

Cross-run dedup currently hashes every file already in the gallery folder and compares against the
hash of each fresh download. That breaks for converted images: the on-disk artefact is a `.webm`
whose hash can never match the `.avif` just downloaded, so every re-import would duplicate every
clip. Hashing the converted output instead only works while VP9 encoding stays bit-deterministic —
true on one machine until a Chrome update, then silently wrong.

**Resolution: carry the original AVIF's hash in the filename.** Converted files land as
`description_01_a1b2c3d4.webm`, where the suffix is the first 8 hex characters of the SHA-256 of the
source bytes. Dedup for converted images is then a substring check against existing gallery
filenames — stable across machines and browser versions, and it lets the expensive encode be skipped
entirely on re-import.

There is precedent: `resolveCollision` in `lib.js` already appends `contentHash.substring(0, 8)`.

Ordering against the existing naming helpers, to be explicit: `generateFilename` yields the
source-tagged stem (`description_01`), the hash marker is appended to that stem for converted files
only, and `resolveCollision` still runs afterwards on the result. In practice the marker makes a
collision essentially impossible for converted files, but `resolveCollision` is left in the path
rather than special-cased — one code path, no branch to get wrong.

Non-converted images keep the existing content-hash path unchanged. Only converted entries get the
filename marker. Filenames are not user-facing in the gallery UI, so the cosmetic cost is nil.

## Encoder settings

- **Codec:** `vp09.00.10.08`, falling back to `vp8` when `VideoEncoder.isConfigSupported` rejects it.
  Probed once per session and cached.
- **Bitrate:** `clamp(width × height × fps × 0.1, 400_000, 4_000_000)`. For `g3.avif` that is
  ~1.18 Mbps, giving roughly 0.77 MB against a 0.93 MB source. The prototype's flat 2 Mbps produced
  output 1.22× *larger* than source, which is the wrong side of parity for a local gallery.
- **GOP:** keyframe every 64 frames (~2 s), which produced clean seeking in the prototype.
- **latencyMode:** `'quality'`.
- **Even alignment:** if either dimension is odd, crop at most 1 px per axis via the `VideoFrame`
  `visibleRect` rather than risk an encoder config rejection. Every image on the reference card is
  already even.
- **Backpressure:** yield to the event loop while `encodeQueueSize > 16`.
- **Timestamps:** re-stamped cumulatively from per-frame `duration`, so container timing is ours
  rather than inherited from the source track.

## Still-frame fallback

Produces a PNG from frame 0 via `OffscreenCanvas` → `convertToBlob({ type: 'image/png' })`. Uses only
canvas, so it works anywhere ST does. Triggered by:

- a non-animated AVIF (`track.animated === false`) — no video needed
- `ImageDecoder` or `VideoEncoder` unavailable
- any throw inside the video path, including mux failure
- exceeding a sanity limit

## Sanity limits

Any of these trips the still-frame fallback rather than grinding the browser:

- more than 1200 frames (37 s at 32 fps — nothing legitimately ships that as an image)
- pixel area above 4096 × 4096
- a 60 s per-image wall-clock deadline, checked inside the frame loop

## Error handling

- Feature detection guards entry: `ImageDecoder` and `VideoEncoder` defined, and
  `await ImageDecoder.isTypeSupported('image/avif')`.
- A failure in the video path degrades to the still path. A failure in the still path increments
  `failed` and the run continues.
- One bad image never aborts the run. `CorsProxyDisabledError` remains the sole exception that
  propagates, unchanged.

## Reporting

`fetchAndImportImages` gains `converted` and `stills` counters alongside `added` / `skipped` /
`failed`. The toast reads like `12 added (11 converted), 2 skipped`. Progress tooltip becomes
`Converting 3/15 (frame 90/167)...`, updated every 16 frames to avoid thrashing the title attribute.

Expected cost on the reference card: ~1.5 s per clip × 15 ≈ 20 s of encoding on top of download time.

## Testing

**`tests/test-webm.js`** (Node, no browser):

- vint at the boundaries that bite: 0, 1, 126, 127, 128, 16382, 16383 — confirming reserved
  all-ones values escalate to the next width.
- `uint` minimal-width encoding, and `element` framing.
- A synthetic full mux with fabricated chunks, re-parsed by a small EBML reader written inside the
  test. Asserts DocType `webm`, TimecodeScale 1000000, CodecID `V_VP9`, PixelWidth/PixelHeight,
  Duration, that clusters break on keyframes, and that SimpleBlock track number, relative timestamp
  and keyframe flag are correct.

**`tests/test-naming.js`** (extended): `.avif` → `.webm` and `.avif` → `.png` mapping, hash-suffixed
filename generation, and the dedup substring check against existing filenames.

**Browser acceptance:** the prototype formalized — a real animated AVIF through the full path into a
`<video>` element, asserting duration against expected, dimensions, and a non-blank frame at
mid-seek. Not expressible in Node; run in the browser.

**End-to-end:** one real import of the reference card in SillyTavern.

## Out of scope

`avif` genuinely belongs in ST's `MEDIA_EXTENSIONS` upstream, and a one-line PR there would make all
of this unnecessary. Worth doing separately, but it doesn't help today and the gallery shouldn't
depend on someone else's merge queue.

No settings UI — the extension has none, and the bitrate constant is a one-line change if tuning is
wanted later.
