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
            try {
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

            if (i % PROGRESS_EVERY === 0) onProgress?.(i, frameCount);
            if (encoder.encodeQueueSize > QUEUE_HIGH_WATER) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        onProgress?.(frameCount, frameCount);
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
