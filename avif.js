/**
 * AVIF conversion for the SillyTavern gallery.
 *
 * SillyTavern's MEDIA_EXTENSIONS allowlist has no entry for avif, so an AVIF is
 * rejected on upload. Animated AVIFs become VP9 WebM (a format the gallery already
 * thumbnails and plays); anything else, or any failure along the way, becomes a
 * first-frame PNG.
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

/**
 * Thrown when a clip is beyond AVIF_LIMITS.
 *
 * Distinct from a generic failure because it is deterministic: no browser and no
 * retry will convert this clip, so its still frame is the final answer rather than
 * a degraded one.
 */
class AvifTooLargeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AvifTooLargeError';
    }
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
    const result = await codecPromise;
    // A null result means every candidate failed, which can happen from a transient
    // fault (isConfigSupported throwing) rather than genuine lack of support. Don't
    // memoize that outcome — a permanently cached null would force every later clip
    // in the session down the still-frame path even after the transient fault clears.
    if (result === null) codecPromise = null;
    return result;
}

/**
 * Decode every frame of an animated AVIF and re-encode it as WebM.
 * Throws on any failure; convertAvif turns that into a still frame.
 */
async function encodeAnimation(decoder, track, onProgress) {
    const frameCount = track.frameCount;

    // Every frame index is decoded EXACTLY ONCE, including frame 0. Firefox's
    // ImageDecoder caches one VideoFrame per index, so closing it poisons any later
    // decode of that same index — an earlier version read dimensions from a separate
    // frame-0 decode, closed it, then hit a closed frame on the loop's first
    // iteration and fell back to a still for every clip. Chrome returns a fresh
    // frame each time and hid the bug completely.
    //
    // Dimensions and frame duration therefore come from the first loop iteration,
    // since the track itself does not expose them. That also means the encoder is
    // configured lazily, inside the loop.
    let encoder = null;
    let encoderError = null;
    let width = 0;
    let height = 0;
    let frameDurationUs = FALLBACK_FRAME_DURATION_US;
    let selected = null;
    const chunks = [];

    try {
        const deadline = Date.now() + AVIF_LIMITS.deadlineMs;
        let timestampUs = 0;

        for (let i = 0; i < frameCount; i++) {
            if (encoderError) throw encoderError;
            if (Date.now() > deadline) {
                throw new Error(`AVIF conversion exceeded ${AVIF_LIMITS.deadlineMs}ms at frame ${i}`);
            }

            const { image } = await decoder.decode({ frameIndex: i });
            try {
                if (i === 0) {
                    ({ width, height } = evenAlign(image.displayWidth, image.displayHeight));
                    frameDurationUs = image.duration || FALLBACK_FRAME_DURATION_US;

                    if (exceedsLimits({ frameCount, width, height })) {
                        throw new AvifTooLargeError(
                            `AVIF exceeds conversion limits: ${frameCount} frames at ${width}x${height}`,
                        );
                    }

                    selected = await selectCodec();
                    if (!selected) throw new Error('No supported video encoder codec');

                    encoder = new VideoEncoder({
                        output: (chunk) => {
                            const data = new Uint8Array(chunk.byteLength);
                            chunk.copyTo(data);
                            chunks.push({ data, timestampUs: chunk.timestamp, key: chunk.type === 'key' });
                        },
                        error: (err) => { encoderError = err; },
                    });
                    encoder.configure({
                        codec: selected.codec,
                        width,
                        height,
                        bitrate: computeBitrate(width, height, Math.round(1000000 / frameDurationUs)),
                        framerate: Math.round(1000000 / frameDurationUs),
                        latencyMode: 'quality',
                    });
                }

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
                }
                timestampUs += duration;
            } finally {
                image.close();
            }

            if (i % PROGRESS_EVERY === 0) onProgress?.(i + 1, frameCount);
            if (encoder.encodeQueueSize > QUEUE_HIGH_WATER) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        if (!encoder) throw new Error('AVIF reported frames but none were decoded');

        await encoder.flush();
        if (encoderError) throw encoderError;

        onProgress?.(frameCount, frameCount);
        const webm = buildWebM({
            width,
            height,
            frameDurationUs,
            durationMs: timestampUs / 1000,
            chunks,
            codec: selected.codecId,
        });
        // Safe only because concatBytes (webm.js) always allocates a new exact-size
        // array: byteOffset is 0 and the view spans the whole buffer. A subarray view
        // here would make arrayBufferToBase64 (index.js) silently append trailing
        // garbage from the backing buffer.
        return { buffer: webm.buffer, ext: '.webm', kind: 'video' };
    } finally {
        // encoder stays null when the clip was rejected before frame 0 finished, or
        // when frameCount was 0 — the lazy construction means it may never exist.
        if (encoder && encoder.state !== 'closed') encoder.close();
    }
}

/**
 * Convert an AVIF into something the SillyTavern gallery accepts.
 *
 * Animated input becomes WebM. Everything else becomes a first-frame PNG, tagged
 * with WHY — because that determines whether the result is final or should be
 * retried later.
 *
 * `retryable: false` means a still is the correct, final answer: the source is not
 * animated, or it is too large to convert on any machine. `retryable: true` means
 * this run could not do better but another could — a browser without WebCodecs, or
 * a transient decode/encode failure. The caller must not let a retryable still
 * satisfy cross-run dedup, or one bad run permanently blocks the real conversion.
 *
 * Only a failure of the still path itself throws; the caller counts that as failed.
 *
 * @param {ArrayBuffer} buffer Original AVIF bytes.
 * @param {(frame: number, total: number) => void} [onProgress]
 * @returns {Promise<{buffer: ArrayBuffer, ext: string, kind: 'video'|'still',
 *                    reason?: string, retryable?: boolean, error?: Error}>}
 */
export async function convertAvif(buffer, onProgress) {
    let reason = 'no-webcodecs';
    let retryable = true;
    let error = null;

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
                reason = 'not-animated';
                retryable = false;
            } else {
                reason = 'avif-decode-unsupported';
            }
        } catch (err) {
            error = err;
            const tooLarge = err instanceof AvifTooLargeError;
            reason = tooLarge ? 'too-large' : 'encode-failed';
            retryable = !tooLarge;
            console.warn(
                `[Chub Gallery] AVIF conversion failed (${reason}), using still frame:`, err,
            );
        } finally {
            decoder?.close();
        }
    }

    // Extracted after the decoder is closed, not inside the catch, so the still path
    // never runs alongside an open decoder.
    const still = await extractStillFrame(buffer);
    return { ...still, reason, retryable, error };
}
