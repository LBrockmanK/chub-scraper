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
