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
