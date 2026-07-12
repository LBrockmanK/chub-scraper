import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { guessExtension, generateFilename, resolveCollision } from '../lib.js';

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
