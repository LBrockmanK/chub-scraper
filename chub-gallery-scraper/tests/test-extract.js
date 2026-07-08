import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { isSiteChrome, extractImagesFromHtml, extractRawImageUrls } from '../lib.js';

describe('isSiteChrome', () => {
    it('filters chub logo URLs', () => {
        assert.equal(isSiteChrome('https://chub.ai/logo/main.png'), true);
    });

    it('filters analytics URLs', () => {
        assert.equal(isSiteChrome('https://google-analytics.com/collect'), true);
    });

    it('passes character image URLs', () => {
        assert.equal(isSiteChrome('https://files.catbox.moe/abc123.png'), false);
    });
});

describe('extractImagesFromHtml', () => {
    it('extracts img tag src', () => {
        const html = '<p>Hello</p><img src="https://example.com/pic.png">';
        const result = extractImagesFromHtml(html, 'description');
        assert.equal(result.length, 1);
        assert.equal(result[0].url, 'https://example.com/pic.png');
        assert.equal(result[0].source, 'description');
    });

    it('extracts CSS background-image', () => {
        const html = "<div style=\"background-image: url('https://example.com/bg.jpg')\"></div>";
        const result = extractImagesFromHtml(html, 'description');
        assert.equal(result.length, 1);
        assert.equal(result[0].url, 'https://example.com/bg.jpg');
    });

    it('extracts markdown images', () => {
        const html = '![alt text](https://example.com/md.png)';
        const result = extractImagesFromHtml(html, 'first_message');
        assert.equal(result.length, 1);
        assert.equal(result[0].url, 'https://example.com/md.png');
        assert.equal(result[0].source, 'first_message');
    });

    it('extracts bare image URLs', () => {
        const html = 'Check out https://example.com/bare.webp for more';
        const result = extractImagesFromHtml(html, 'description');
        assert.equal(result.length, 1);
        assert.equal(result[0].url, 'https://example.com/bare.webp');
    });

    it('deduplicates URLs within same field', () => {
        const html = '<img src="https://example.com/a.png"><img src="https://example.com/a.png">';
        const result = extractImagesFromHtml(html, 'description');
        assert.equal(result.length, 1);
    });

    it('filters site chrome URLs', () => {
        const html = '<img src="https://chub.ai/logo/main.png"><img src="https://example.com/real.png">';
        const result = extractImagesFromHtml(html, 'description');
        assert.equal(result.length, 1);
        assert.equal(result[0].url, 'https://example.com/real.png');
    });

    it('handles multiple images with identical filenames from different hosts', () => {
        const html = '<img src="https://host1.com/image.png"><img src="https://host2.com/image.png">';
        const result = extractImagesFromHtml(html, 'description');
        assert.equal(result.length, 2);
    });

    it('handles CSS url with no quotes', () => {
        const html = '<div style="background-image: url(https://example.com/nq.jpg)"></div>';
        const result = extractImagesFromHtml(html, 'description');
        assert.equal(result.length, 1);
        assert.equal(result[0].url, 'https://example.com/nq.jpg');
    });

    it('returns empty array for text with no images', () => {
        const result = extractImagesFromHtml('Just plain text here', 'description');
        assert.equal(result.length, 0);
    });
});

describe('extractRawImageUrls', () => {
    it('extracts avatar and card URLs', () => {
        const node = {
            avatar_url: 'https://example.com/avatar.png',
            max_res_url: 'https://example.com/card.jpg',
        };
        const result = extractRawImageUrls(node);
        assert.equal(result.length, 2);
        assert.equal(result[0].source, 'avatar');
        assert.equal(result[1].source, 'card');
    });

    it('extracts background from extensions.chub', () => {
        const node = {
            extensions: { chub: { background_image: 'https://example.com/bg.png' } },
        };
        const result = extractRawImageUrls(node);
        assert.equal(result.length, 1);
        assert.equal(result[0].source, 'background');
    });

    it('extracts background from definition.extensions.chub', () => {
        const node = {
            definition: {
                extensions: { chub: { background_image: 'https://example.com/defbg.png' } },
            },
        };
        const result = extractRawImageUrls(node);
        assert.equal(result.length, 1);
        assert.equal(result[0].source, 'background');
    });

    it('extracts gallery URLs passed as parameter', () => {
        const node = {};
        const gallery = ['https://example.com/g1.png', 'https://example.com/g2.png'];
        const result = extractRawImageUrls(node, gallery);
        assert.equal(result.length, 2);
        assert.equal(result[0].source, 'gallery');
        assert.equal(result[1].source, 'gallery');
    });

    it('extracts embedded images from description', () => {
        const node = {
            description: '<img src="https://example.com/desc.png">',
        };
        const result = extractRawImageUrls(node);
        assert.equal(result.length, 1);
        assert.equal(result[0].source, 'description');
    });

    it('extracts from first_message and alternate_greetings', () => {
        const node = {
            definition: {
                first_message: '<img src="https://example.com/fm.png">',
                alternate_greetings: [
                    '<img src="https://example.com/ag1.png">',
                    '<img src="https://example.com/ag2.png">',
                ],
            },
        };
        const result = extractRawImageUrls(node);
        assert.equal(result.length, 3);
        assert.equal(result[0].source, 'first_message');
        assert.equal(result[1].source, 'greeting_1');
        assert.equal(result[2].source, 'greeting_2');
    });

    it('deduplicates across all sources', () => {
        const node = {
            avatar_url: 'https://example.com/same.png',
            max_res_url: 'https://example.com/same.png',
            description: '<img src="https://example.com/same.png">',
        };
        const result = extractRawImageUrls(node);
        assert.equal(result.length, 1);
    });

    it('handles missing/empty fields gracefully', () => {
        const node = {};
        const result = extractRawImageUrls(node);
        assert.equal(result.length, 0);
    });

    it('handles null definition gracefully', () => {
        const node = { definition: null };
        const result = extractRawImageUrls(node);
        assert.equal(result.length, 0);
    });

    it('skips empty alternate greetings', () => {
        const node = {
            definition: {
                alternate_greetings: ['', null, '<img src="https://example.com/g3.png">'],
            },
        };
        const result = extractRawImageUrls(node);
        assert.equal(result.length, 1);
        assert.equal(result[0].source, 'greeting_3');
    });
});
