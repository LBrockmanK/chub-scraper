import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
    guessExtension, generateFilename, resolveCollision,
    ST_MEDIA_EXTENSIONS, VIDEO_EXTENSIONS, needsConversion, appendHashMarker, filenamesContainMarker,
} from '../lib.js';

describe('guessExtension', () => {
    it('uses content-type when available', () => {
        assert.equal(guessExtension('https://example.com/foo', 'image/png'), '.png');
    });

    it('handles content-type with charset suffix', () => {
        assert.equal(guessExtension('https://example.com/foo', 'image/jpeg; charset=utf-8'), '.jpg');
    });

    it('falls back to URL path extension', () => {
        assert.equal(guessExtension('https://example.com/photo.webp', ''), '.webp');
    });

    it('returns .bin when nothing matches', () => {
        assert.equal(guessExtension('https://example.com/blob', ''), '.bin');
    });

    it('detects PNG from magic bytes when content-type and URL fail', () => {
        const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]).buffer;
        assert.equal(guessExtension('https://example.com/blob', '', png), '.png');
    });

    it('detects JPEG from magic bytes', () => {
        const jpg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
        assert.equal(guessExtension('https://example.com/blob', '', jpg), '.jpg');
    });

    it('detects WebP from magic bytes', () => {
        const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer;
        assert.equal(guessExtension('https://example.com/blob', '', webp), '.webp');
    });

    it('detects GIF from magic bytes', () => {
        const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]).buffer;
        assert.equal(guessExtension('https://example.com/blob', '', gif), '.gif');
    });

    it('prefers content-type over magic bytes', () => {
        const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]).buffer;
        assert.equal(guessExtension('https://example.com/blob', 'image/jpeg', png), '.jpg');
    });

    it('handles URL with query parameters', () => {
        assert.equal(guessExtension('https://example.com/img.png?w=500', ''), '.png');
    });

    it('is case-insensitive for URL extensions', () => {
        assert.equal(guessExtension('https://example.com/img.PNG', ''), '.png');
    });

    it('normalizes .jpeg to .jpg in URL fallback', () => {
        assert.equal(guessExtension('https://example.com/photo.jpeg', ''), '.jpg');
        assert.equal(guessExtension('https://example.com/photo.JPEG', ''), '.jpg');
    });

    it('recognizes all supported MIME types', () => {
        assert.equal(guessExtension('', 'image/webp'), '.webp');
        assert.equal(guessExtension('', 'image/gif'), '.gif');
        assert.equal(guessExtension('', 'image/bmp'), '.bmp');
        assert.equal(guessExtension('', 'image/svg+xml'), '.svg');
        assert.equal(guessExtension('', 'image/avif'), '.avif');
    });
});

describe('generateFilename', () => {
    it('uses bare name for avatar', () => {
        assert.equal(generateFilename('avatar', new Map(), '.png'), 'avatar.png');
    });

    it('uses bare name for card', () => {
        assert.equal(generateFilename('card', new Map(), '.jpg'), 'card.jpg');
    });

    it('uses bare name for background', () => {
        assert.equal(generateFilename('background', new Map(), '.webp'), 'background.webp');
    });

    it('uses indexed name for gallery', () => {
        const counters = new Map();
        assert.equal(generateFilename('gallery', counters, '.png'), 'gallery_01.png');
        assert.equal(generateFilename('gallery', counters, '.jpg'), 'gallery_02.jpg');
    });

    it('uses indexed name for description', () => {
        const counters = new Map();
        assert.equal(generateFilename('description', counters, '.png'), 'description_01.png');
    });

    it('tracks counts independently per source', () => {
        const counters = new Map();
        assert.equal(generateFilename('gallery', counters, '.png'), 'gallery_01.png');
        assert.equal(generateFilename('description', counters, '.jpg'), 'description_01.jpg');
        assert.equal(generateFilename('gallery', counters, '.png'), 'gallery_02.png');
        assert.equal(generateFilename('description', counters, '.png'), 'description_02.png');
    });

    it('preserves underscores in greeting source names', () => {
        const counters = new Map();
        assert.equal(generateFilename('greeting_1', counters, '.png'), 'greeting_1_01.png');
        assert.equal(generateFilename('greeting_2', counters, '.png'), 'greeting_2_01.png');
    });

    it('preserves first_message source name', () => {
        const counters = new Map();
        assert.equal(generateFilename('first_message', counters, '.png'), 'first_message_01.png');
    });
});

describe('resolveCollision', () => {
    it('returns original filename if no collision', () => {
        const existing = new Set(['other.png']);
        assert.equal(
            resolveCollision('gallery_01.png', existing, 'abcdef1234567890'),
            'gallery_01.png',
        );
    });

    it('appends 8-char hash suffix on collision', () => {
        const existing = new Set(['gallery_01.png']);
        assert.equal(
            resolveCollision('gallery_01.png', existing, 'abcdef1234567890'),
            'gallery_01_abcdef12.png',
        );
    });

    it('preserves extension correctly', () => {
        const existing = new Set(['avatar.webp']);
        const result = resolveCollision('avatar.webp', existing, 'deadbeef99887766');
        assert.equal(result, 'avatar_deadbeef.webp');
    });

    it('handles singular source collisions (re-fetch scenario)', () => {
        const existing = new Set(['card.jpg']);
        const result = resolveCollision('card.jpg', existing, '1122334455667788');
        assert.equal(result, 'card_11223344.jpg');
    });
});

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

describe('VIDEO_EXTENSIONS', () => {
    it('contains video formats', () => {
        assert.ok(VIDEO_EXTENSIONS.has('.mp4'));
        assert.ok(VIDEO_EXTENSIONS.has('.webm'));
    });

    it('does not contain still-image formats', () => {
        assert.equal(VIDEO_EXTENSIONS.has('.png'), false);
        assert.equal(VIDEO_EXTENSIONS.has('.jpeg'), false);
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

    it('does not match a marker that only appears before an earlier dot', () => {
        const existing = new Set(['clip_a1b2c3d4.old.mp4']);
        assert.equal(filenamesContainMarker(existing, 'a1b2c3d4'), false);
    });

    it('matches an extensionless filename ending in the marker', () => {
        const existing = new Set(['gallery_01_a1b2c3d4']);
        assert.equal(filenamesContainMarker(existing, 'a1b2c3d4'), true);
    });
});
