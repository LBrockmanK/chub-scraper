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
