# AVIF → WebM Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically convert animated AVIF images embedded in Chub cards into VP9 WebM so they land in the SillyTavern character gallery, with a first-frame PNG fallback when conversion isn't possible.

**Architecture:** A new pure-bytes module `webm.js` writes a single-track Matroska/WebM container from encoded chunks. A new module `avif.js` drives `ImageDecoder` → `VideoEncoder` → `buildWebM` in the browser, degrading to a `createImageBitmap` still frame on any failure. `lib.js` gains the pure naming and dedup helpers; `index.js` gets one insertion point in its import loop.

**Tech Stack:** Vanilla ESM, no build step, no dependencies. WebCodecs (`ImageDecoder`, `VideoEncoder`), `OffscreenCanvas`, `createImageBitmap`. Tests are `node:test` + `node:assert`.

**Spec:** `docs/superpowers/specs/2026-07-26-avif-conversion-design.md`

## Global Constraints

- **Zero dependencies.** No npm packages, no vendored third-party code, no build step. The extension is loaded as raw ESM by SillyTavern.
- **`avif.js` must be importable in Node.** Never touch `ImageDecoder`, `VideoEncoder`, `OffscreenCanvas`, or `document` at module scope — only inside function bodies, guarded by `typeof`. This is what makes its pure helpers unit-testable.
- **Append-only.** Never delete or overwrite an existing gallery image.
- **One bad image never aborts the run.** `CorsProxyDisabledError` remains the sole exception that propagates out of the per-image loop.
- **Run tests with:** `node --test tests/` from the repo root.
- **Indentation:** 4 spaces, matching `lib.js` and `index.js`.
- **Exact constants, copied verbatim from the spec:** bitrate `clamp(width × height × fps × 0.1, 400000, 4000000)`; GOP 64 frames; `latencyMode: 'quality'`; TimecodeScale `1000000`; max 1200 frames; max pixel area `4096 × 4096`; per-image deadline 60000 ms; backpressure yield above `encodeQueueSize > 16`; progress emitted every 16 frames; hash marker is the first 8 hex characters of the SHA-256 of the **original** bytes.

---

### Task 1: EBML primitives

**Files:**
- Create: `webm.js`
- Test: `tests/test-webm.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `vint(n: number) → Uint8Array` — EBML size vint with length descriptor.
  - `uint(n: number) → Uint8Array` — big-endian unsigned integer, minimal width.
  - `float64(n: number) → Uint8Array` — 8-byte IEEE-754 big-endian.
  - `concatBytes(arrays: Uint8Array[]) → Uint8Array`
  - `element(id: number[], payload: Uint8Array) → Uint8Array`

- [ ] **Step 1: Write the failing test**

Create `tests/test-webm.js`:

```javascript
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { vint, uint, float64, concatBytes, element } from '../webm.js';

const hex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');

describe('vint', () => {
    it('encodes small values in one byte', () => {
        assert.equal(hex(vint(0)), '80');
        assert.equal(hex(vint(1)), '81');
        assert.equal(hex(vint(126)), 'fe');
    });

    it('escalates at 127 because all-ones is reserved for unknown size', () => {
        // 0xFF would mean "unknown size", so 127 must widen to two bytes.
        assert.equal(hex(vint(127)), '40 7f');
        assert.equal(hex(vint(128)), '40 80');
    });

    it('uses two bytes up to the two-byte reserved value', () => {
        assert.equal(hex(vint(16382)), '7f fe');
    });

    it('escalates at 16383 for the same reason', () => {
        assert.equal(hex(vint(16383)), '20 3f ff');
    });
});

describe('uint', () => {
    it('encodes zero as a single byte', () => {
        assert.equal(hex(uint(0)), '00');
    });

    it('uses minimal width', () => {
        assert.equal(hex(uint(1)), '01');
        assert.equal(hex(uint(255)), 'ff');
        assert.equal(hex(uint(256)), '01 00');
    });

    it('encodes the TimecodeScale value', () => {
        assert.equal(hex(uint(1000000)), '0f 42 40');
    });
});

describe('float64', () => {
    it('round-trips through a DataView', () => {
        const bytes = float64(5218.75);
        assert.equal(bytes.length, 8);
        const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
        assert.equal(view.getFloat64(0), 5218.75);
    });
});

describe('concatBytes', () => {
    it('joins arrays in order', () => {
        const out = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])]);
        assert.equal(hex(out), '01 02 03');
    });

    it('returns an empty array for no input', () => {
        assert.equal(concatBytes([]).length, 0);
    });
});

describe('element', () => {
    it('frames id, size vint, then payload', () => {
        const out = element([0x86], new Uint8Array([0xAA, 0xBB]));
        assert.equal(hex(out), '86 82 aa bb');
    });

    it('handles multi-byte ids', () => {
        const out = element([0x2A, 0xD7, 0xB1], uint(1000000));
        assert.equal(hex(out), '2a d7 b1 83 0f 42 40');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test-webm.js`
Expected: FAIL — `Cannot find module` for `../webm.js`.

- [ ] **Step 3: Write minimal implementation**

Create `webm.js`:

```javascript
/**
 * Minimal EBML / Matroska writer for single-track WebM.
 *
 * Pure byte manipulation — no browser APIs, so this is unit-testable in Node.
 */

/**
 * EBML size vint with length descriptor.
 *
 * A vint whose value bits are all ones is reserved to mean "unknown size", so
 * any value equal to 2^(7*len)-1 must widen to the next byte count. Correct for
 * sizes below 2^49; larger sizes are unreachable here.
 */
export function vint(n) {
    let len = 1;
    while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
    const out = new Uint8Array(len);
    let v = n;
    for (let i = len - 1; i >= 0; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
    }
    out[0] |= 1 << (8 - len);
    return out;
}

/** Big-endian unsigned integer, minimal width. */
export function uint(n) {
    const bytes = [];
    let v = n;
    do {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
    } while (v > 0);
    return new Uint8Array(bytes);
}

/** 8-byte big-endian IEEE-754 double. */
export function float64(n) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, n);
    return out;
}

export function concatBytes(arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

/** Frame a payload as an EBML element: id, size vint, payload. */
export function element(id, payload) {
    return concatBytes([new Uint8Array(id), vint(payload.length), payload]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/test-webm.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add webm.js tests/test-webm.js
git commit -m "feat: EBML primitives for WebM muxing"
```

---

### Task 2: WebM container writer

**Files:**
- Modify: `webm.js` (append)
- Test: `tests/test-webm.js` (append)

**Interfaces:**
- Consumes: `vint`, `uint`, `float64`, `concatBytes`, `element` from Task 1.
- Produces:
  - `buildWebM({ width, height, frameDurationUs, durationMs, chunks, codec }) → Uint8Array`
  - `chunks` is `Array<{ data: Uint8Array, timestampUs: number, key: boolean }>`
  - `codec` is the Matroska CodecID string, `'V_VP9'` or `'V_VP8'`. Defaults to `'V_VP9'`.
  - Throws `Error('buildWebM: no chunks')` when `chunks` is empty.

- [ ] **Step 1: Write the failing test**

Append to `tests/test-webm.js`. This includes a small EBML reader so the test asserts on parsed
structure rather than on a brittle byte-for-byte golden value.

```javascript
import { buildWebM } from '../webm.js';

// --- Minimal EBML reader, test-only ---

function descriptorLength(firstByte) {
    let len = 1;
    for (let mask = 0x80; mask > 0; mask >>= 1) {
        if (firstByte & mask) break;
        len++;
    }
    return len;
}

function readId(buf, offset) {
    const len = descriptorLength(buf[offset]);
    let id = '';
    for (let i = 0; i < len; i++) id += buf[offset + i].toString(16).padStart(2, '0');
    return { id, len };
}

function readSize(buf, offset) {
    const len = descriptorLength(buf[offset]);
    let value = buf[offset] & (0xff >> len);
    for (let i = 1; i < len; i++) value = value * 256 + buf[offset + i];
    return { value, len };
}

/** Yields the direct children of a byte range. */
function* children(buf, start, end) {
    let offset = start;
    while (offset < end) {
        const { id, len: idLen } = readId(buf, offset);
        const { value: size, len: sizeLen } = readSize(buf, offset + idLen);
        const dataStart = offset + idLen + sizeLen;
        yield { id, size, data: buf.subarray(dataStart, dataStart + size) };
        offset = dataStart + size;
    }
}

const childrenOf = (data) => [...children(data, 0, data.length)];
const find = (data, id) => childrenOf(data).find(c => c.id === id);
const findAll = (data, id) => childrenOf(data).filter(c => c.id === id);
const readUint = (data) => data.reduce((acc, b) => acc * 256 + b, 0);
const readStr = (data) => new TextDecoder().decode(data);

// --- Fixtures ---

function fakeChunks(count, frameDurationUs, gop) {
    const chunks = [];
    for (let i = 0; i < count; i++) {
        chunks.push({
            data: new Uint8Array([i & 0xff, 0x55]),
            timestampUs: i * frameDurationUs,
            key: i % gop === 0,
        });
    }
    return chunks;
}

describe('buildWebM', () => {
    const FRAME_US = 31250; // 32 fps
    const build = () => buildWebM({
        width: 608,
        height: 608,
        frameDurationUs: FRAME_US,
        durationMs: 167 * FRAME_US / 1000,
        chunks: fakeChunks(167, FRAME_US, 64),
        codec: 'V_VP9',
    });

    it('throws when given no chunks', () => {
        assert.throws(
            () => buildWebM({ width: 8, height: 8, frameDurationUs: 1, durationMs: 1, chunks: [] }),
            /no chunks/,
        );
    });

    it('starts with an EBML header declaring DocType webm', () => {
        const top = childrenOf(build());
        assert.equal(top[0].id, '1a45dfa3');
        assert.equal(readStr(find(top[0].data, '4282').data), 'webm');
    });

    it('declares a 1ms TimecodeScale and the clip duration in Info', () => {
        const top = childrenOf(build());
        const segment = top.find(c => c.id === '18538067');
        const info = find(segment.data, '1549a966');
        assert.equal(readUint(find(info.data, '2ad7b1').data), 1000000);

        const durationBytes = find(info.data, '4489').data;
        const view = new DataView(durationBytes.buffer, durationBytes.byteOffset, 8);
        assert.equal(view.getFloat64(0), 5218.75);
    });

    it('declares one VP9 video track with the source dimensions', () => {
        const segment = childrenOf(build()).find(c => c.id === '18538067');
        const trackEntry = find(find(segment.data, '1654ae6b').data, 'ae');

        assert.equal(readUint(find(trackEntry.data, 'd7').data), 1);   // TrackNumber
        assert.equal(readUint(find(trackEntry.data, '83').data), 1);   // TrackType: video
        assert.equal(readStr(find(trackEntry.data, '86').data), 'V_VP9');
        assert.equal(readUint(find(trackEntry.data, '23e383').data), FRAME_US * 1000); // ns

        const video = find(trackEntry.data, 'e0');
        assert.equal(readUint(find(video.data, 'b0').data), 608);
        assert.equal(readUint(find(video.data, 'ba').data), 608);
    });

    it('honours a VP8 codec id', () => {
        const webm = buildWebM({
            width: 64, height: 64, frameDurationUs: FRAME_US, durationMs: 62.5,
            chunks: fakeChunks(2, FRAME_US, 64), codec: 'V_VP8',
        });
        const segment = childrenOf(webm).find(c => c.id === '18538067');
        const trackEntry = find(find(segment.data, '1654ae6b').data, 'ae');
        assert.equal(readStr(find(trackEntry.data, '86').data), 'V_VP8');
    });

    it('opens a new cluster at each keyframe', () => {
        const segment = childrenOf(build()).find(c => c.id === '18538067');
        const clusters = findAll(segment.data, '1f43b675');
        // 167 frames, keyframes at 0/64/128 => 3 clusters
        assert.equal(clusters.length, 3);
        assert.deepEqual(
            clusters.map(c => readUint(find(c.data, 'e7').data)),
            [0, 2000, 4000],
        );
    });

    it('writes every frame exactly once across all clusters', () => {
        const segment = childrenOf(build()).find(c => c.id === '18538067');
        const clusters = findAll(segment.data, '1f43b675');
        const blocks = clusters.flatMap(c => findAll(c.data, 'a3'));
        assert.equal(blocks.length, 167);
    });

    it('writes SimpleBlocks with track number, relative timestamp and keyframe flag', () => {
        const segment = childrenOf(build()).find(c => c.id === '18538067');
        const clusters = findAll(segment.data, '1f43b675');

        const firstBlock = findAll(clusters[0].data, 'a3')[0].data;
        assert.equal(firstBlock[0], 0x81);                                  // track 1
        assert.equal(new DataView(firstBlock.buffer, firstBlock.byteOffset).getInt16(1), 0);
        assert.equal(firstBlock[3], 0x80);                                  // keyframe
        assert.deepEqual([...firstBlock.subarray(4)], [0, 0x55]);           // payload

        const secondBlock = findAll(clusters[0].data, 'a3')[1].data;
        assert.equal(new DataView(secondBlock.buffer, secondBlock.byteOffset).getInt16(1), 31);
        assert.equal(secondBlock[3], 0x00);                                 // delta
    });

    it('keeps every cluster-relative timestamp inside int16 range', () => {
        // 40 seconds of frames with a single leading keyframe: the writer must
        // still split, because SimpleBlock offsets are signed 16-bit.
        const chunks = fakeChunks(1280, FRAME_US, 100000);
        const webm = buildWebM({
            width: 64, height: 64, frameDurationUs: FRAME_US,
            durationMs: 1280 * FRAME_US / 1000, chunks,
        });
        const segment = childrenOf(webm).find(c => c.id === '18538067');
        const clusters = findAll(segment.data, '1f43b675');

        // Do NOT assert `rel >= -32768 && rel <= 32767` here — getInt16 returns a signed
        // 16-bit interpretation of two bytes, so that can never fail. The real failure mode
        // is a WRAPPED NEGATIVE offset, which is what these assertions catch. An earlier
        // draft of this plan shipped the tautology, and deleting MAX_CLUSTER_SPAN_MS from
        // webm.js entirely left the suite green.
        assert.equal(clusters.length, 2);

        let chunkIndex = 0;
        for (const cluster of clusters) {
            const baseMs = readUint(find(cluster.data, 'e7').data);
            for (const block of findAll(cluster.data, 'a3')) {
                const rel = new DataView(block.data.buffer, block.data.byteOffset).getInt16(1);
                assert.ok(rel >= 0, `relative timestamp went negative: ${rel}`);
                assert.equal(baseMs + rel, Math.round(chunks[chunkIndex].timestampUs / 1000));
                chunkIndex++;
            }
        }
        assert.equal(chunkIndex, chunks.length);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test-webm.js`
Expected: FAIL — `buildWebM is not a function` (or an import error).

- [ ] **Step 3: Write minimal implementation**

Append to `webm.js`:

```javascript
const MAX_CLUSTER_SPAN_MS = 30000;

/**
 * Build a single-track WebM from encoded video chunks.
 *
 * VP8 and VP9 need no CodecPrivate, which is why this writer can stay small —
 * WebCodecs emits no `decoderConfig.description` for either.
 *
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.frameDurationUs
 * @param {number} opts.durationMs
 * @param {Array<{data: Uint8Array, timestampUs: number, key: boolean}>} opts.chunks
 * @param {string} [opts.codec] Matroska CodecID, 'V_VP9' (default) or 'V_VP8'.
 * @returns {Uint8Array}
 */
export function buildWebM({ width, height, frameDurationUs, durationMs, chunks, codec = 'V_VP9' }) {
    if (!chunks || chunks.length === 0) {
        throw new Error('buildWebM: no chunks');
    }

    const text = (s) => new TextEncoder().encode(s);

    const header = element([0x1A, 0x45, 0xDF, 0xA3], concatBytes([
        element([0x42, 0x86], uint(1)),          // EBMLVersion
        element([0x42, 0xF7], uint(1)),          // EBMLReadVersion
        element([0x42, 0xF2], uint(4)),          // EBMLMaxIDLength
        element([0x42, 0xF3], uint(8)),          // EBMLMaxSizeLength
        element([0x42, 0x82], text('webm')),     // DocType
        element([0x42, 0x87], uint(2)),          // DocTypeVersion
        element([0x42, 0x85], uint(2)),          // DocTypeReadVersion
    ]));

    const info = element([0x15, 0x49, 0xA9, 0x66], concatBytes([
        element([0x2A, 0xD7, 0xB1], uint(1000000)),          // TimecodeScale: 1ms
        element([0x4D, 0x80], text('chub-gallery-scraper')), // MuxingApp
        element([0x57, 0x41], text('chub-gallery-scraper')), // WritingApp
        element([0x44, 0x89], float64(durationMs)),          // Duration
    ]));

    const tracks = element([0x16, 0x54, 0xAE, 0x6B], element([0xAE], concatBytes([
        element([0xD7], uint(1)),                            // TrackNumber
        element([0x73, 0xC5], uint(1)),                      // TrackUID
        element([0x83], uint(1)),                            // TrackType: video
        element([0x86], text(codec)),                        // CodecID
        element([0x23, 0xE3, 0x83], uint(frameDurationUs * 1000)), // DefaultDuration (ns)
        element([0xE0], concatBytes([
            element([0xB0], uint(width)),                    // PixelWidth
            element([0xBA], uint(height)),                   // PixelHeight
        ])),
    ])));

    const clusters = [];
    let blocks = null;
    let baseMs = 0;

    const closeCluster = () => {
        if (!blocks) return;
        clusters.push(element([0x1F, 0x43, 0xB6, 0x75], concatBytes([
            element([0xE7], uint(baseMs)), // Timecode
            ...blocks,
        ])));
    };

    for (const chunk of chunks) {
        const timestampMs = Math.round(chunk.timestampUs / 1000);
        const startsCluster = !blocks
            || (chunk.key && timestampMs > baseMs)
            || timestampMs - baseMs > MAX_CLUSTER_SPAN_MS;

        if (startsCluster) {
            closeCluster();
            blocks = [];
            baseMs = timestampMs;
        }

        const blockHeader = new Uint8Array(4);
        blockHeader[0] = 0x81; // track number 1 as a vint
        new DataView(blockHeader.buffer).setInt16(1, timestampMs - baseMs);
        blockHeader[3] = chunk.key ? 0x80 : 0x00;

        blocks.push(element([0xA3], concatBytes([blockHeader, chunk.data])));
    }
    closeCluster();

    const segment = element([0x18, 0x53, 0x80, 0x67], concatBytes([info, tracks, ...clusters]));
    return concatBytes([header, segment]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/test-webm.js`
Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add webm.js tests/test-webm.js
git commit -m "feat: single-track WebM container writer"
```

---

### Task 3: Conversion predicates and hash-marker naming

**Files:**
- Modify: `lib.js` (append after `resolveCollision`)
- Test: `tests/test-naming.js` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ST_MEDIA_EXTENSIONS: Set<string>` — extensions SillyTavern's `MEDIA_EXTENSIONS` accepts, dotted.
  - `needsConversion(ext: string) → boolean`
  - `appendHashMarker(filename: string, marker: string) → string`
  - `filenamesContainMarker(filenames: Iterable<string>, marker: string) → boolean`

- [ ] **Step 1: Write the failing test**

Append to `tests/test-naming.js`, and extend the existing import on line 3 to pull in the new
functions:

```javascript
// Line 3 becomes:
import {
    guessExtension, generateFilename, resolveCollision,
    ST_MEDIA_EXTENSIONS, needsConversion, appendHashMarker, filenamesContainMarker,
} from '../lib.js';
```

Then append:

```javascript
describe('ST_MEDIA_EXTENSIONS', () => {
    it('includes the formats SillyTavern accepts', () => {
        for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.webm', '.mp4']) {
            assert.ok(ST_MEDIA_EXTENSIONS.has(ext), `expected ${ext} to be accepted`);
        }
    });

    it('excludes avif, which is why conversion exists', () => {
        assert.equal(ST_MEDIA_EXTENSIONS.has('.avif'), false);
    });

    it('excludes svg, which SillyTavern also rejects', () => {
        // Documented, not handled: converting SVG is out of scope for this change.
        assert.equal(ST_MEDIA_EXTENSIONS.has('.svg'), false);
    });
});

describe('needsConversion', () => {
    it('is true for avif', () => {
        assert.equal(needsConversion('.avif'), true);
    });

    it('is false for formats the gallery already accepts', () => {
        assert.equal(needsConversion('.png'), false);
        assert.equal(needsConversion('.webm'), false);
        assert.equal(needsConversion('.gif'), false);
    });

    it('is false for formats we cannot convert', () => {
        assert.equal(needsConversion('.svg'), false);
        assert.equal(needsConversion('.bin'), false);
    });
});

describe('appendHashMarker', () => {
    it('inserts the marker before the extension', () => {
        assert.equal(appendHashMarker('description_01.webm', 'a1b2c3d4'), 'description_01_a1b2c3d4.webm');
    });

    it('works on singular source names', () => {
        assert.equal(appendHashMarker('card.png', 'deadbeef'), 'card_deadbeef.png');
    });

    it('only splits on the final dot', () => {
        assert.equal(appendHashMarker('a.b.webm', '11223344'), 'a.b_11223344.webm');
    });
});

describe('filenamesContainMarker', () => {
    it('finds a marker regardless of source tag or extension', () => {
        const existing = new Set(['description_01_a1b2c3d4.webm', 'card.png']);
        assert.equal(filenamesContainMarker(existing, 'a1b2c3d4'), true);
    });

    it('is false when the marker is absent', () => {
        const existing = new Set(['description_01_ffffffff.webm']);
        assert.equal(filenamesContainMarker(existing, 'a1b2c3d4'), false);
    });

    it('matches the same source content converted to a different format', () => {
        // A clip first imported as a still PNG, then re-imported: still a duplicate.
        const existing = new Set(['description_01_a1b2c3d4.png']);
        assert.equal(filenamesContainMarker(existing, 'a1b2c3d4'), true);
    });

    it('does not match a marker appearing outside the suffix position', () => {
        const existing = new Set(['a1b2c3d4_gallery_01.webm']);
        assert.equal(filenamesContainMarker(existing, 'a1b2c3d4'), false);
    });

    it('is false for an empty collection', () => {
        assert.equal(filenamesContainMarker(new Set(), 'a1b2c3d4'), false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test-naming.js`
Expected: FAIL — `needsConversion is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `lib.js`:

```javascript
/**
 * Extensions SillyTavern's MEDIA_EXTENSIONS allowlist accepts (src/constants.js).
 *
 * Both /api/images/upload and /api/images/list gate on this list, so anything
 * absent here is rejected on upload and invisible in the gallery even if the
 * file is placed in the folder by hand. Notably absent: avif, svg.
 */
export const ST_MEDIA_EXTENSIONS = new Set([
    '.bmp', '.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp',
    '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.3gp', '.mkv', '.mpg',
]);

/** True for formats we both need to convert and know how to convert. */
export function needsConversion(ext) {
    return ext === '.avif';
}

/** Insert a content-hash marker before the extension. */
export function appendHashMarker(filename, marker) {
    const dotIdx = filename.lastIndexOf('.');
    const base = filename.substring(0, dotIdx);
    const ext = filename.substring(dotIdx);
    return `${base}_${marker}${ext}`;
}

/**
 * Cross-run dedup for converted images.
 *
 * A converted file's bytes never hash to its source's hash, so the source hash
 * rides along in the filename instead. Matching on `_marker.` keeps the marker
 * anchored to the suffix position.
 */
export function filenamesContainMarker(filenames, marker) {
    const needle = `_${marker}.`;
    for (const name of filenames) {
        if (name.includes(needle)) return true;
    }
    return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/`
Expected: PASS — all three test files, no failures.

- [ ] **Step 5: Commit**

```bash
git add lib.js tests/test-naming.js
git commit -m "feat: conversion predicate and hash-marker naming helpers"
```

---

### Task 4: `avif.js` pure helpers and still-frame extraction

**Files:**
- Create: `avif.js`
- Test: `tests/test-avif.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `AVIF_LIMITS: { maxFrames: 1200, maxPixels: 16777216, deadlineMs: 60000 }`
  - `computeBitrate(width: number, height: number, fps: number) → number`
  - `exceedsLimits({ frameCount, width, height }) → boolean`
  - `evenAlign(width: number, height: number) → { width, height }`
  - `hasWebCodecs() → boolean`
  - `extractStillFrame(buffer: ArrayBuffer) → Promise<{ buffer: ArrayBuffer, ext: '.png', kind: 'still' }>`

**Critical:** every browser global must be referenced inside a function body and guarded by
`typeof`, so this module imports cleanly in Node. The Node tests below depend on that.

- [ ] **Step 1: Write the failing test**

Create `tests/test-avif.js`:

```javascript
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { AVIF_LIMITS, computeBitrate, exceedsLimits, evenAlign, hasWebCodecs } from '../avif.js';

describe('computeBitrate', () => {
    it('scales with pixels and frame rate at 0.1 bits per pixel per frame', () => {
        // 608 * 608 * 32 * 0.1 = 1182924.8, rounded
        assert.equal(computeBitrate(608, 608, 32), 1182925);
    });

    it('clamps tiny inputs up to the floor', () => {
        assert.equal(computeBitrate(64, 64, 8), 400000);
    });

    it('clamps huge inputs down to the ceiling', () => {
        assert.equal(computeBitrate(1920, 1080, 60), 4000000);
    });
});

describe('exceedsLimits', () => {
    it('accepts the real-world reference clip', () => {
        assert.equal(exceedsLimits({ frameCount: 167, width: 608, height: 608 }), false);
    });

    it('accepts exactly the frame ceiling', () => {
        assert.equal(exceedsLimits({ frameCount: 1200, width: 64, height: 64 }), false);
    });

    it('rejects one frame past the ceiling', () => {
        assert.equal(exceedsLimits({ frameCount: 1201, width: 64, height: 64 }), true);
    });

    it('rejects an oversized frame area', () => {
        assert.equal(exceedsLimits({ frameCount: 2, width: 8192, height: 8192 }), true);
    });
});

describe('evenAlign', () => {
    it('leaves even dimensions untouched', () => {
        assert.deepEqual(evenAlign(608, 608), { width: 608, height: 608 });
    });

    it('rounds odd dimensions down by one pixel', () => {
        assert.deepEqual(evenAlign(609, 607), { width: 608, height: 606 });
    });
});

describe('hasWebCodecs', () => {
    it('is false in Node, where WebCodecs does not exist', () => {
        // Also proves avif.js imports without touching browser globals at module scope.
        assert.equal(hasWebCodecs(), false);
    });
});

describe('AVIF_LIMITS', () => {
    it('matches the values in the design spec', () => {
        assert.equal(AVIF_LIMITS.maxFrames, 1200);
        assert.equal(AVIF_LIMITS.maxPixels, 4096 * 4096);
        assert.equal(AVIF_LIMITS.deadlineMs, 60000);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test-avif.js`
Expected: FAIL — `Cannot find module` for `../avif.js`.

- [ ] **Step 3: Write minimal implementation**

Create `avif.js`:

```javascript
/**
 * AVIF conversion for the SillyTavern gallery.
 *
 * SillyTavern's MEDIA_EXTENSIONS allowlist has no entry for avif, so an AVIF is
 * rejected on upload and invisible in the gallery listing. Animated AVIFs become
 * VP9 WebM (a format the gallery already thumbnails and plays); anything else,
 * or any failure along the way, becomes a first-frame PNG.
 *
 * Browser globals are referenced only inside function bodies so this module
 * stays importable in Node for unit testing.
 */

import { buildWebM } from './webm.js';

export const AVIF_LIMITS = {
    maxFrames: 1200,        // 37s at 32fps — nothing legitimately ships that as an image
    maxPixels: 4096 * 4096,
    deadlineMs: 60000,      // per-image wall-clock budget
};

const BITS_PER_PIXEL_PER_FRAME = 0.1;
const MIN_BITRATE = 400000;
const MAX_BITRATE = 4000000;

/** Target bitrate for a clip, sized so output lands near source parity. */
export function computeBitrate(width, height, fps) {
    const raw = Math.round(width * height * fps * BITS_PER_PIXEL_PER_FRAME);
    return Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, raw));
}

/** True when a clip is too large to convert without hurting the browser. */
export function exceedsLimits({ frameCount, width, height }) {
    return frameCount > AVIF_LIMITS.maxFrames
        || width * height > AVIF_LIMITS.maxPixels;
}

/** Encoders can reject odd dimensions; crop at most one pixel per axis. */
export function evenAlign(width, height) {
    return { width: width - (width % 2), height: height - (height % 2) };
}

/** Whether this browser can decode AVIF frames and encode video. */
export function hasWebCodecs() {
    return typeof ImageDecoder !== 'undefined'
        && typeof VideoEncoder !== 'undefined'
        && typeof OffscreenCanvas !== 'undefined';
}

/**
 * First frame of an AVIF as a PNG.
 *
 * Uses createImageBitmap rather than ImageDecoder so it works in any browser
 * that can render AVIF at all — which is the point of it being the fallback.
 */
export async function extractStillFrame(buffer) {
    const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/avif' }));
    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return { buffer: await blob.arrayBuffer(), ext: '.png', kind: 'still' };
    } finally {
        bitmap.close();
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/`
Expected: PASS — four test files, no failures.

- [ ] **Step 5: Commit**

```bash
git add avif.js tests/test-avif.js
git commit -m "feat: AVIF conversion limits, bitrate sizing and still-frame fallback"
```

---

### Task 5: Animated AVIF → WebM conversion

**Files:**
- Modify: `avif.js` (append)

**Interfaces:**
- Consumes: `buildWebM` (Task 2); `AVIF_LIMITS`, `computeBitrate`, `exceedsLimits`, `evenAlign`,
  `hasWebCodecs`, `extractStillFrame` (Task 4).
- Produces:
  - `convertAvif(buffer: ArrayBuffer, onProgress?: (frame: number, total: number) => void)`
    `→ Promise<{ buffer: ArrayBuffer, ext: '.webm' | '.png', kind: 'video' | 'still' }>`

This task is browser-only — `ImageDecoder` and `VideoEncoder` do not exist in Node, so there is no
unit test. Verification is the browser harness in Task 7. The pure helpers it builds on are already
covered by Task 4.

- [ ] **Step 1: Append the implementation to `avif.js`**

```javascript
const GOP = 64;                 // keyframe every ~2s at 32fps
const QUEUE_HIGH_WATER = 16;
const PROGRESS_EVERY = 16;
const FALLBACK_FRAME_DURATION_US = 33333; // ~30fps, only if a frame reports none

let codecPromise = null;

/**
 * Pick a codec the browser can actually encode, once per session.
 *
 * Probed at a fixed nominal size — VP8/VP9 support does not vary by resolution,
 * so caching one answer for the session is safe.
 *
 * @returns {Promise<{codec: string, codecId: string}|null>}
 */
async function selectCodec() {
    if (!codecPromise) {
        codecPromise = (async () => {
            const candidates = [
                { codec: 'vp09.00.10.08', codecId: 'V_VP9' },
                { codec: 'vp8', codecId: 'V_VP8' },
            ];
            for (const candidate of candidates) {
                try {
                    const support = await VideoEncoder.isConfigSupported({
                        codec: candidate.codec, width: 640, height: 480, bitrate: MIN_BITRATE,
                    });
                    if (support.supported) return candidate;
                } catch {
                    // Unsupported codec strings can throw rather than report false.
                }
            }
            return null;
        })();
    }
    return codecPromise;
}

/**
 * Decode every frame of an animated AVIF and re-encode it as WebM.
 * Throws on any failure; convertAvif turns that into a still frame.
 */
async function encodeAnimation(decoder, track, onProgress) {
    // Dimensions and frame duration come from the decoded first frame rather than
    // the track, which does not expose them.
    const first = await decoder.decode({ frameIndex: 0 });
    const { width, height } = evenAlign(first.image.displayWidth, first.image.displayHeight);
    const frameDurationUs = first.image.duration || FALLBACK_FRAME_DURATION_US;
    first.image.close();

    const frameCount = track.frameCount;
    if (exceedsLimits({ frameCount, width, height })) {
        throw new Error(`AVIF exceeds conversion limits: ${frameCount} frames at ${width}x${height}`);
    }

    const fps = Math.round(1000000 / frameDurationUs);
    const selected = await selectCodec();
    if (!selected) throw new Error('No supported video encoder codec');

    const chunks = [];
    let encoderError = null;
    const encoder = new VideoEncoder({
        output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            chunks.push({ data, timestampUs: chunk.timestamp, key: chunk.type === 'key' });
        },
        error: (err) => { encoderError = err; },
    });

    try {
        encoder.configure({
            codec: selected.codec,
            width,
            height,
            bitrate: computeBitrate(width, height, fps),
            framerate: fps,
            latencyMode: 'quality',
        });

        const deadline = Date.now() + AVIF_LIMITS.deadlineMs;
        let timestampUs = 0;

        for (let i = 0; i < frameCount; i++) {
            if (encoderError) throw encoderError;
            if (Date.now() > deadline) {
                throw new Error(`AVIF conversion exceeded ${AVIF_LIMITS.deadlineMs}ms at frame ${i}`);
            }

            const { image } = await decoder.decode({ frameIndex: i });
            const duration = image.duration || frameDurationUs;
            // Re-stamp cumulatively so container timing is ours, and crop to even
            // dimensions in the same step.
            const frame = new VideoFrame(image, {
                timestamp: timestampUs,
                duration,
                visibleRect: { x: 0, y: 0, width, height },
            });
            try {
                encoder.encode(frame, { keyFrame: i % GOP === 0 });
            } finally {
                frame.close();
                image.close();
            }
            timestampUs += duration;

            if (i % PROGRESS_EVERY === 0) onProgress?.(i, frameCount);
            if (encoder.encodeQueueSize > QUEUE_HIGH_WATER) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        await encoder.flush();
        if (encoderError) throw encoderError;

        const webm = buildWebM({
            width,
            height,
            frameDurationUs,
            durationMs: timestampUs / 1000,
            chunks,
            codec: selected.codecId,
        });
        return { buffer: webm.buffer, ext: '.webm', kind: 'video' };
    } finally {
        if (encoder.state !== 'closed') encoder.close();
    }
}

/**
 * Convert an AVIF into something the SillyTavern gallery accepts.
 *
 * Animated input becomes WebM. Static input, a browser without WebCodecs, or any
 * failure in the video path becomes a first-frame PNG. Only a failure of the
 * still path throws — the caller counts that as a failed image.
 *
 * @param {ArrayBuffer} buffer Original AVIF bytes.
 * @param {(frame: number, total: number) => void} [onProgress]
 */
export async function convertAvif(buffer, onProgress) {
    if (hasWebCodecs()) {
        let decoder = null;
        try {
            if (await ImageDecoder.isTypeSupported('image/avif')) {
                decoder = new ImageDecoder({ data: buffer, type: 'image/avif' });
                await decoder.tracks.ready;
                const track = decoder.tracks.selectedTrack;
                if (track?.animated && track.frameCount > 1) {
                    return await encodeAnimation(decoder, track, onProgress);
                }
            }
        } catch (err) {
            console.warn('[Chub Gallery] AVIF video conversion failed, using still frame:', err);
        } finally {
            decoder?.close();
        }
    }
    return extractStillFrame(buffer);
}
```

- [ ] **Step 2: Verify the module still imports in Node**

Run: `node --test tests/`
Expected: PASS — four test files, no failures. This confirms the new browser-only code did not
introduce a module-scope reference to a browser global.

- [ ] **Step 3: Verify the export surface**

Run: `node --input-type=module -e "import('./avif.js').then(m => console.log(Object.keys(m).sort().join(',')))"`
Expected: `AVIF_LIMITS,computeBitrate,convertAvif,evenAlign,exceedsLimits,extractStillFrame,hasWebCodecs`

- [ ] **Step 4: Commit**

```bash
git add avif.js
git commit -m "feat: convert animated AVIF to VP9 WebM via WebCodecs"
```

---

### Task 6: Wire conversion into the import pipeline

**Files:**
- Modify: `index.js:1-6` (imports), `index.js:157-169` and `index.js:171-175` (loop body),
  `index.js:139` and `index.js:148-150` and `index.js:184` (counters), `index.js:243-247` (toast)

**Interfaces:**
- Consumes: `needsConversion`, `appendHashMarker`, `filenamesContainMarker` (Task 3); `convertAvif` (Task 5).
- Produces: `fetchAndImportImages` result gains `converted: number` and `stills: number` alongside
  the existing `added`, `skipped`, `failed`, `total`.

- [ ] **Step 1: Extend the imports**

Replace `index.js` lines 1-6 with:

```javascript
import {
    extractRawImageUrls,
    guessExtension,
    generateFilename,
    resolveCollision,
    needsConversion,
    appendHashMarker,
    filenamesContainMarker,
} from './lib.js';
import { convertAvif } from './avif.js';
```

- [ ] **Step 2: Add the new counters**

In `fetchAndImportImages`, the early return for no images (currently line 139) must carry the new
fields so callers never see `undefined`. Replace:

```javascript
        return { added: 0, skipped: 0, failed: 0, total: 0 };
```

with:

```javascript
        return { added: 0, skipped: 0, failed: 0, converted: 0, stills: 0, total: 0 };
```

And alongside the existing counter declarations (currently lines 148-150), add:

```javascript
    let converted = 0;
    let stills = 0;
```

- [ ] **Step 3: Reorder the loop body and insert conversion**

Extension detection has to move ahead of the dedup check, because which dedup test applies depends
on whether the file needs converting. Inside the per-image loop, replace lines 157-169 — from
`const { buffer, contentType } = await downloadImage(entry.url);` through
`existingNames.add(filename);` inclusive — with:

```javascript
            const { buffer, contentType } = await downloadImage(entry.url);
            const contentHash = await hashContent(buffer);
            const sourceExt = guessExtension(entry.url, contentType, buffer);
            const marker = contentHash.substring(0, 8);
            const convert = needsConversion(sourceExt);

            // Converted files can never hash-match their source on disk, so they
            // dedup on the hash marker carried in the filename instead.
            const alreadyPresent = convert
                ? filenamesContainMarker(existingNames, marker)
                : existingHashes.has(contentHash);

            if (alreadyPresent || batchHashes.has(contentHash)) {
                skipped++;
                continue;
            }
            batchHashes.add(contentHash);

            let uploadBuffer = buffer;
            let uploadExt = sourceExt;
            if (convert) {
                const result = await convertAvif(buffer, (frame, total) => {
                    onProgress(`Converting ${i + 1}/${imageEntries.length} (frame ${frame}/${total})...`);
                });
                uploadBuffer = result.buffer;
                uploadExt = result.ext;
                if (result.kind === 'video') converted++;
                else stills++;
            }

            let filename = generateFilename(entry.source, sourceCounters, uploadExt);
            if (convert) filename = appendHashMarker(filename, marker);
            filename = resolveCollision(filename, existingNames, contentHash);
            existingNames.add(filename);
```

- [ ] **Step 4: Upload the converted bytes, not the original**

Replace lines 171-175 — the block from `const base64 = arrayBufferToBase64(buffer);` through the
`await uploadToGallery(...)` call — with:

```javascript
            const base64 = arrayBufferToBase64(uploadBuffer);
            const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));
            const formatWithoutDot = uploadExt.substring(1);

            await uploadToGallery(base64, formatWithoutDot, galleryFolder, nameWithoutExt);
```

- [ ] **Step 5: Return the new counters**

Replace the final return of `fetchAndImportImages`:

```javascript
    return { added, skipped, failed, converted, stills, total: imageEntries.length };
```

- [ ] **Step 6: Report conversions in the toast**

Replace the summary block in the click handler (currently lines 243-247) with:

```javascript
            const parts = [];
            if (result.added > 0) {
                const detail = [];
                if (result.converted > 0) detail.push(`${result.converted} converted`);
                if (result.stills > 0) detail.push(`${result.stills} as still frames`);
                parts.push(detail.length > 0
                    ? `${result.added} added (${detail.join(', ')})`
                    : `${result.added} added`);
            }
            if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
            if (result.failed > 0) parts.push(`${result.failed} failed`);
            if (result.total === 0) parts.push('No images on Chub');
```

- [ ] **Step 7: Verify nothing regressed**

Run: `node --test tests/`
Expected: PASS — four test files, no failures.

Run: `node --input-type=module -e "import('./lib.js').then(() => console.log('lib ok'))"`
Expected: `lib ok`

- [ ] **Step 8: Commit**

```bash
git add index.js
git commit -m "feat: convert AVIF during import and report conversion counts"
```

---

### Task 7: Browser and end-to-end verification

**Files:**
- Create: `tests/browser/verify-avif.js`

This is the acceptance gate. `ImageDecoder` and `VideoEncoder` cannot run in Node, so the real
decode → encode → mux → play path is proven in a browser.

**Interfaces:**
- Consumes: `convertAvif` (Task 5).
- Produces: `verifyAvifConversion(baseUrl) → Promise<object>` — a report with a `pass` boolean.

- [ ] **Step 1: Write the verification harness**

Create `tests/browser/verify-avif.js`:

```javascript
/**
 * Browser-only acceptance check for AVIF conversion.
 *
 * WebCodecs does not exist in Node, so this path cannot be covered by the
 * node:test suite. Run it in a browser console from the extension folder:
 *
 *   const { verifyAvifConversion } = await import('./tests/browser/verify-avif.js');
 *   await verifyAvifConversion('https://waking-up-naked-next-to-a-verry-happy-elf.pages.dev');
 *
 * Returns a report object; `pass` is true when every assertion held.
 */

import { convertAvif } from '../../avif.js';

const CASES = [
    { file: 'g3.avif', expectFrames: 167, expectWidth: 608, expectHeight: 608, expectDurationMs: 5218.75 },
    { file: 'Ending_Puppy_24fps.avif', expectFrames: 131, expectWidth: 608, expectHeight: 608, expectDurationMs: 5458.25 },
    { file: 'G1_Roselle_32FPS_Part1_f0-156.avif', expectFrames: 157, expectWidth: 512, expectHeight: 768, expectDurationMs: 4906.25 },
];

const TOLERANCE_MS = 60;

/** Load a blob into a <video> and report what the browser makes of it. */
async function probeVideo(blob) {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;
    try {
        const metadata = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout waiting for metadata')), 10000);
            video.onerror = () => {
                clearTimeout(timer);
                reject(new Error(`video error: ${video.error?.message ?? 'unknown'}`));
            };
            video.onloadedmetadata = () => {
                clearTimeout(timer);
                resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
            };
        });

        // Seek to the middle and confirm the frame carries real image content,
        // which catches a container that parses but decodes to nothing.
        video.currentTime = metadata.duration / 2;
        await new Promise(resolve => {
            video.onseeked = resolve;
            setTimeout(resolve, 3000);
        });

        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 64, 64);
        const pixels = ctx.getImageData(0, 0, 64, 64).data;
        let nonBlank = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8) nonBlank++;
        }
        return { ...metadata, seekedTo: video.currentTime, nonBlank, sampled: 64 * 64 };
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function verifyAvifConversion(baseUrl) {
    const results = [];

    for (const testCase of CASES) {
        const failures = [];
        try {
            const response = await fetch(`${baseUrl}/${encodeURIComponent(testCase.file)}`);
            if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
            const source = await response.arrayBuffer();

            const started = performance.now();
            const converted = await convertAvif(source);
            const elapsedMs = Math.round(performance.now() - started);

            if (converted.kind !== 'video') failures.push(`kind was '${converted.kind}', expected 'video'`);
            if (converted.ext !== '.webm') failures.push(`ext was '${converted.ext}', expected '.webm'`);

            const probe = await probeVideo(new Blob([converted.buffer], { type: 'video/webm' }));
            if (Math.abs(probe.duration * 1000 - testCase.expectDurationMs) > TOLERANCE_MS) {
                failures.push(`duration ${probe.duration}s, expected ~${testCase.expectDurationMs}ms`);
            }
            if (probe.width !== testCase.expectWidth) failures.push(`width ${probe.width}, expected ${testCase.expectWidth}`);
            if (probe.height !== testCase.expectHeight) failures.push(`height ${probe.height}, expected ${testCase.expectHeight}`);
            if (probe.nonBlank < probe.sampled * 0.5) failures.push(`mid-seek frame mostly blank (${probe.nonBlank}/${probe.sampled})`);

            results.push({
                file: testCase.file,
                pass: failures.length === 0,
                failures,
                sourceBytes: source.byteLength,
                webmBytes: converted.buffer.byteLength,
                sizeRatio: +(converted.buffer.byteLength / source.byteLength).toFixed(2),
                elapsedMs,
                probe,
            });
        } catch (err) {
            results.push({ file: testCase.file, pass: false, failures: [...failures, String(err)] });
        }
    }

    return { pass: results.every(r => r.pass), results };
}
```

- [ ] **Step 2: Run the harness in the browser**

Serve the extension folder and run the harness.

**Do not use `python -m http.server`.** On Windows it reads MIME types from the registry, where `.js`
is commonly mapped to `text/plain`, and browsers refuse to execute an ES module served with a
non-JavaScript MIME type. This was hit during execution and cost real debugging time. Use a server
that forces the mapping — save this as `serve.py` outside the repo and run it from anywhere:

```python
import functools, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SimpleHTTPRequestHandler.extensions_map.update({'.js': 'text/javascript', '.mjs': 'text/javascript'})

handler = functools.partial(SimpleHTTPRequestHandler, directory=sys.argv[1])
ThreadingHTTPServer(('127.0.0.1', int(sys.argv[2])), handler).serve_forever()
```

```bash
python serve.py . 8766
```

Confirm the MIME type before loading anything in the browser — this one check prevents the whole
failure mode:

```bash
curl -s -o /dev/null -w "%{content_type}\n" http://localhost:8766/avif.js
```

Expected: `text/javascript`. If you have already loaded any module from this port under a wrong MIME
type, the browser has cached it and will keep failing even after you fix the server — a relative
import like `avif.js`'s `./webm.js` resolves to the un-busted URL and hits the poisoned cache entry.
Switch to a fresh port rather than fighting the cache.

Then in the browser at `http://localhost:8766`, in the console:

```javascript
const { verifyAvifConversion } = await import('/tests/browser/verify-avif.js');
console.log(JSON.stringify(await verifyAvifConversion('https://waking-up-naked-next-to-a-verry-happy-elf.pages.dev'), null, 2));
```

Expected: `pass: true` for all three cases. Each `sizeRatio` should land near or below `1.0`, and
each `elapsedMs` in the low thousands. If a `sizeRatio` comes back well above `1.0`, the bitrate
constant `BITS_PER_PIXEL_PER_FRAME` in `avif.js` is too high — report the numbers rather than
silently retuning.

- [ ] **Step 3: Verify the still-frame fallback**

In the same console:

```javascript
const { extractStillFrame } = await import('/avif.js');  // served from port 8766, see Step 2
const src = await (await fetch('https://waking-up-naked-next-to-a-verry-happy-elf.pages.dev/g3.avif')).arrayBuffer();
const still = await extractStillFrame(src);
const header = new Uint8Array(still.buffer).subarray(0, 4);
console.log({ ext: still.ext, kind: still.kind, bytes: still.buffer.byteLength, isPng: header[0] === 0x89 && header[1] === 0x50 });
```

Expected: `ext: '.png'`, `kind: 'still'`, `isPng: true`, and a non-trivial byte count.

- [ ] **Step 4: End-to-end in SillyTavern**

Commit and push, then update the extension through ST's extension manager (never copy files into the
ST directory by hand). Open the reference character:

`chub.ai/characters/R_Endsa_Q/waking-up-naked-next-to-a-very-happy-elf-i-mean-look-at-her-have-you-seen-her-mooshly-badabongs-b2d788175b7d`

Click the gallery's Chub fetch button and confirm:

- The tooltip shows `Converting N/M (frame X/Y)...` during the run.
- The toast reports a non-zero `converted` count.
- The gallery grid shows video thumbnails for the clips.
- Clicking a clip opens a `<video>` that plays.
- Clicking fetch a second time reports everything as `skipped`, adding nothing — this is the
  hash-marker dedup working across runs.

- [ ] **Step 5: Commit**

```bash
git add tests/browser/verify-avif.js
git commit -m "test: browser acceptance harness for AVIF conversion"
```

---

## Self-Review Notes

**Spec coverage:** Problem statement → Task 3 (`ST_MEDIA_EXTENSIONS` documents the allowlist).
`webm.js` → Tasks 1-2. `avif.js` → Tasks 4-5. `lib.js` additions → Task 3. `index.js` insertion
point → Task 6. Dedup → Task 3 (helpers) and Task 6 (branch). Encoder settings → Task 5, with
bitrate and limits unit-tested in Task 4. Still-frame fallback → Task 4 (`extractStillFrame`) and
Task 5 (`convertAvif` routing). Sanity limits → Task 4 (`exceedsLimits`, tested) and Task 5
(deadline). Error handling → Task 5. Reporting → Task 6. Testing → Tasks 1-4 in Node, Task 7 in
browser.

**Deliberate omissions, carried from the spec:** no upstream ST patch, no settings UI, no SVG
handling. SVG is a real adjacent gap — it is also absent from `MEDIA_EXTENSIONS`, so SVG images from
cards fail upload today — but converting it is a separate change with its own design questions.

**Line-number caveat:** the ranges cited in Task 6 are against `index.js` at commit `b7a5ec2`. Tasks
1-5 do not touch `index.js`, so they should still hold — but match on the quoted code, not the
numbers, if anything has shifted.

**Verified constants:** the expected values in the Task 1-4 tests were computed by hand rather than
copied from a run — `vint(16382)` → `7f fe`, `vint(16383)` → `20 3f ff`, `uint(1000000)` →
`0f 42 40`, `computeBitrate(608, 608, 32)` → `1182925`, and the three clip durations in Task 7
(167 × 31250 µs → 5218.75 ms, 131 × 41666 µs → 5458.25 ms, 157 × 31250 µs → 4906.25 ms). The first
of those was confirmed against a live browser run during design; if any other disagrees with reality
at implementation time, check the arithmetic before changing the implementation.
