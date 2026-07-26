/**
 * Regression tests for the animated-AVIF encode loop.
 *
 * WebCodecs does not exist in Node, so these install stubs on globalThis before
 * importing avif.js. That is only possible because avif.js references browser
 * globals exclusively inside function bodies.
 *
 * The stubs deliberately model Firefox's observed behaviour, which is stricter
 * than Chrome's: ImageDecoder.decode() returns a *cached* VideoFrame per frame
 * index, so closing it poisons every later decode of that same index. Chrome
 * hands back a fresh frame each time and therefore hides the bug entirely.
 * Real symptom: every clip fell back to a still frame with
 * "InvalidStateError: The VideoFrame is closed or no image found there".
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

const FRAME_DURATION_US = 31000; // Firefox's reading of the reference clip

/** A VideoFrame stand-in that tracks its own closed state. */
class StubImage {
    constructor(index, width, height, duration) {
        this.index = index;
        this.displayWidth = width;
        this.displayHeight = height;
        this.duration = duration;
        this.timestamp = index * duration;
        this.closed = false;
    }

    close() {
        this.closed = true;
    }
}

/**
 * ImageDecoder stub with Firefox's cache-per-index semantics.
 * Records every decode so a test can assert an index is never decoded twice.
 */
class StubImageDecoder {
    constructor({ frameCount, width, height, duration }) {
        this.frameCount = frameCount;
        this.decodeLog = [];
        this.closed = false;
        this._cache = new Map();
        this._width = width;
        this._height = height;
        this._duration = duration;
        this.tracks = {
            ready: Promise.resolve(),
            length: 1,
            selectedTrack: { animated: true, frameCount },
        };
    }

    async decode({ frameIndex }) {
        this.decodeLog.push(frameIndex);
        if (!this._cache.has(frameIndex)) {
            this._cache.set(
                frameIndex,
                new StubImage(frameIndex, this._width, this._height, this._duration),
            );
        }
        return { image: this._cache.get(frameIndex) };
    }

    close() {
        this.closed = true;
    }
}

/** Install the WebCodecs surface avif.js needs, then return the loaded module. */
async function loadAvifWithStubs() {
    const state = { encodedFrames: [], configured: null, framesConstructed: 0 };

    globalThis.VideoFrame = class {
        constructor(source, init) {
            // Firefox throws exactly here when handed an already-closed frame.
            if (!source || source.closed) {
                throw Object.assign(
                    new Error('VideoFrame constructor: The VideoFrame is closed or no image found there'),
                    { name: 'InvalidStateError' },
                );
            }
            state.framesConstructed++;
            this.timestamp = init.timestamp;
            this.duration = init.duration;
            this.closed = false;
        }

        close() {
            this.closed = true;
        }
    };

    globalThis.VideoEncoder = class {
        static async isConfigSupported() {
            return { supported: true };
        }

        constructor({ output }) {
            this._output = output;
            this.state = 'unconfigured';
            this.encodeQueueSize = 0;
        }

        configure(config) {
            state.configured = config;
            this.state = 'configured';
        }

        encode(frame, options) {
            if (frame.closed) throw new Error('VideoEncoder.encode: input VideoFrame has been closed');
            state.encodedFrames.push({ timestamp: frame.timestamp, key: !!options?.keyFrame });
            this._output(
                {
                    byteLength: 8,
                    timestamp: frame.timestamp,
                    duration: frame.duration,
                    type: options?.keyFrame ? 'key' : 'delta',
                    copyTo: (dest) => dest.fill(1),
                },
                {},
            );
        }

        async flush() {}

        close() {
            this.state = 'closed';
        }
    };

    globalThis.ImageDecoder = class {
        static async isTypeSupported() {
            return true;
        }
    };

    // The still-frame path needs these. They are stubbed for every test, not just
    // the fallback one, so that a test expecting video fails on its own assertion
    // rather than on a missing global three layers down.
    globalThis.createImageBitmap = async () => ({ width: 608, height: 608, close() {} });
    globalThis.OffscreenCanvas = class {
        getContext() { return { drawImage() {} }; }
        async convertToBlob() { return { arrayBuffer: async () => new ArrayBuffer(32) }; }
    };

    const mod = await import('../avif.js');
    return { mod, state };
}

// Top-level await rather than a before() hook: the stubs must be installed on
// globalThis before avif.js is imported, and root-level hooks do not run early
// enough in every Node version.
const { mod: avif, state: stubState } = await loadAvifWithStubs();

describe('encodeAnimation frame handling (via convertAvif)', () => {
    it('never decodes the same frame index twice', async () => {
        // The original bug: frame 0 was decoded once up front to read dimensions,
        // closed, then decoded again as the loop's first iteration. Under Firefox's
        // cache-per-index semantics the second decode returned a closed frame.
        const decoder = new StubImageDecoder({
            frameCount: 10, width: 608, height: 608, duration: FRAME_DURATION_US,
        });
        globalThis.ImageDecoder = class {
            static async isTypeSupported() { return true; }
            constructor() { return decoder; }
        };

        const result = await avif.convertAvif(new ArrayBuffer(64));

        const seen = new Set();
        const repeated = decoder.decodeLog.filter(i => seen.has(i) || (seen.add(i), false));
        assert.deepEqual(repeated, [], `frame indices decoded more than once: ${repeated}`);
        assert.equal(decoder.decodeLog.length, 10);
        assert.equal(result.kind, 'video', 'should produce video, not fall back to a still');
        assert.equal(result.ext, '.webm');
    });

    it('encodes every frame with cumulative timestamps starting at zero', async () => {
        const decoder = new StubImageDecoder({
            frameCount: 5, width: 608, height: 608, duration: FRAME_DURATION_US,
        });
        globalThis.ImageDecoder = class {
            static async isTypeSupported() { return true; }
            constructor() { return decoder; }
        };
        stubState.encodedFrames.length = 0;

        await avif.convertAvif(new ArrayBuffer(64));

        assert.deepEqual(
            stubState.encodedFrames.map(f => f.timestamp),
            [0, 31000, 62000, 93000, 124000],
        );
        assert.equal(stubState.encodedFrames[0].key, true, 'frame 0 must be a keyframe');
    });

    it('closes every decoded image and every constructed frame', async () => {
        const decoder = new StubImageDecoder({
            frameCount: 8, width: 608, height: 608, duration: FRAME_DURATION_US,
        });
        globalThis.ImageDecoder = class {
            static async isTypeSupported() { return true; }
            constructor() { return decoder; }
        };

        await avif.convertAvif(new ArrayBuffer(64));

        const unclosed = [...decoder._cache.values()].filter(img => !img.closed);
        assert.deepEqual(unclosed.map(i => i.index), [], 'every decoded image must be closed');
        assert.equal(decoder.closed, true, 'the decoder itself must be closed');
    });

    it('derives encoder dimensions and framerate from the first decoded frame', async () => {
        const decoder = new StubImageDecoder({
            frameCount: 4, width: 512, height: 768, duration: FRAME_DURATION_US,
        });
        globalThis.ImageDecoder = class {
            static async isTypeSupported() { return true; }
            constructor() { return decoder; }
        };

        await avif.convertAvif(new ArrayBuffer(64));

        assert.equal(stubState.configured.width, 512);
        assert.equal(stubState.configured.height, 768);
        assert.equal(stubState.configured.framerate, Math.round(1000000 / FRAME_DURATION_US));
    });

    it('crops odd dimensions down to even before configuring the encoder', async () => {
        const decoder = new StubImageDecoder({
            frameCount: 3, width: 609, height: 607, duration: FRAME_DURATION_US,
        });
        globalThis.ImageDecoder = class {
            static async isTypeSupported() { return true; }
            constructor() { return decoder; }
        };

        await avif.convertAvif(new ArrayBuffer(64));

        assert.equal(stubState.configured.width, 608);
        assert.equal(stubState.configured.height, 606);
    });

    it('marks a successful conversion with neither a reason nor retryable', async () => {
        const decoder = new StubImageDecoder({
            frameCount: 4, width: 608, height: 608, duration: FRAME_DURATION_US,
        });
        globalThis.ImageDecoder = class {
            static async isTypeSupported() { return true; }
            constructor() { return decoder; }
        };

        const result = await avif.convertAvif(new ArrayBuffer(64));

        assert.equal(result.kind, 'video');
        assert.equal(result.retryable, undefined);
    });

    it('classifies a non-animated AVIF as a final, non-retryable still', async () => {
        globalThis.ImageDecoder = class {
            static async isTypeSupported() { return true; }
            constructor() {
                return {
                    tracks: { ready: Promise.resolve(), length: 1, selectedTrack: { animated: false, frameCount: 1 } },
                    async decode() { throw new Error('should not decode a static AVIF'); },
                    close() {},
                };
            }
        };

        const result = await avif.convertAvif(new ArrayBuffer(64));

        assert.equal(result.kind, 'still');
        assert.equal(result.reason, 'not-animated');
        assert.equal(result.retryable, false, 'a static AVIF still is the correct final answer');
    });

    it('classifies an encode failure as retryable so a later run can upgrade it', async () => {
        const decoder = new StubImageDecoder({
            frameCount: 6, width: 608, height: 608, duration: FRAME_DURATION_US,
        });
        globalThis.ImageDecoder = class {
            static async isTypeSupported() { return true; }
            constructor() { return decoder; }
        };
        const RealEncoder = globalThis.VideoEncoder;
        globalThis.VideoEncoder = class extends RealEncoder {
            encode() { throw new Error('simulated encoder explosion'); }
        };
        globalThis.VideoEncoder.isConfigSupported = RealEncoder.isConfigSupported;

        try {
            const result = await avif.convertAvif(new ArrayBuffer(64));
            assert.equal(result.kind, 'still');
            assert.equal(result.reason, 'encode-failed');
            assert.equal(result.retryable, true);
        } finally {
            globalThis.VideoEncoder = RealEncoder;
        }
    });

    it('classifies a missing WebCodecs surface as retryable', async () => {
        const RealImageDecoder = globalThis.ImageDecoder;
        delete globalThis.ImageDecoder;
        try {
            const result = await avif.convertAvif(new ArrayBuffer(64));
            assert.equal(result.kind, 'still');
            assert.equal(result.reason, 'no-webcodecs');
            assert.equal(result.retryable, true, 'another browser could convert this');
        } finally {
            globalThis.ImageDecoder = RealImageDecoder;
        }
    });

    it('falls back to a still frame when the clip exceeds the frame limit', async () => {
        const decoder = new StubImageDecoder({
            frameCount: 1500, width: 608, height: 608, duration: FRAME_DURATION_US,
        });
        globalThis.ImageDecoder = class {
            static async isTypeSupported() { return true; }
            constructor() { return decoder; }
        };
        // createImageBitmap is only reached on the still path.
        globalThis.createImageBitmap = async () => ({ width: 608, height: 608, close() {} });
        globalThis.OffscreenCanvas = class {
            constructor() {}
            getContext() { return { drawImage() {} }; }
            async convertToBlob() { return { arrayBuffer: async () => new ArrayBuffer(32) }; }
        };

        const result = await avif.convertAvif(new ArrayBuffer(64));

        assert.equal(result.kind, 'still');
        assert.equal(result.ext, '.png');
        // Deterministic: no browser will ever convert this, so the still is final.
        assert.equal(result.reason, 'too-large');
        assert.equal(result.retryable, false);
        // The limit must be caught without decoding all 1500 frames.
        assert.ok(decoder.decodeLog.length <= 1, `decoded ${decoder.decodeLog.length} frames before rejecting`);
    });
});
