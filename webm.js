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
