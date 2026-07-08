# Chub Gallery Scraper ST Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a SillyTavern third-party extension that scrapes all images from a Chub.ai character page and adds them to the character's ST gallery.

**Architecture:** Pure client-side extension. `lib.js` contains all pure logic (URL extraction, filename generation, dedup tracking) with zero browser or ST dependencies — fully testable in Node.js. `index.js` handles ST lifecycle, API calls (Chub via CORS proxy, ST gallery), UI injection, and orchestration. All external requests go through ST's CORS proxy.

**Tech Stack:** Vanilla JavaScript (ES modules), SillyTavern extension API, Node.js `node:test` for unit tests

## Global Constraints

- Append-only: never delete or overwrite existing gallery images
- Auto-detect only: reads `character.data.extensions.chub.full_path`, no manual URL input
- Chub API requires `?full=true` query param and browser-like User-Agent
- Gallery API on separate domain: `gateway.chub.ai` (not `api.chub.ai`)
- Gallery folder resolved via `extensionSettings.gallery.folders[char.avatar] ?? char.name`
- Button always visible, greyed out and disabled when no chub metadata

## File Structure

```
chub-gallery-scraper/
  manifest.json       — ST extension metadata
  package.json        — {"type": "module"} for Node test runner
  index.js            — ST integration, API calls, UI, orchestration
  lib.js              — pure logic: URL extraction, naming, dedup (no browser deps)
  style.css           — button and status styling
  tests/
    test-extract.js   — URL extraction tests
    test-naming.js    — filename generation + dedup tests
```

| File | Responsibility | Dependencies |
|------|---------------|--------------|
| `lib.js` | Pure functions: `extractRawImageUrls()`, `extractImagesFromHtml()`, `isSiteChrome()`, `generateFilename()`, `resolveCollision()`, `guessExtension()` | None |
| `index.js` | ST lifecycle: extension init, button injection, event wiring, `corsFetch()`, `fetchCharacterFromChub()`, `fetchGalleryFromChub()`, `hashContent()`, `getExistingGalleryHashes()`, `uploadToGallery()`, `fetchAndImportImages()` | `lib.js`, ST globals |
| `style.css` | `.chub-fetch-btn`, `.chub-fetch-btn:disabled`, `.chub-status` rules | None |
| `manifest.json` | `display_name`, `loading_order`, `requires`, `js`, `css` | None |

---

### Task 1: Image URL Extraction

**Files:**
- Create: `lib.js`, `tests/test-extract.js`, `manifest.json`, `package.json`
- Create: `index.js` (skeleton — empty jQuery ready block)
- Create: `style.css` (empty)

**Interfaces:**
- Produces: `isSiteChrome(url: string) → boolean`
- Produces: `extractImagesFromHtml(html: string, fieldName: string) → Array<{url: string, source: string}>`
- Produces: `extractRawImageUrls(node: object, galleryImageUrls?: string[]) → Array<{url: string, source: string}>`

- [ ] **Step 1: Create scaffold files**

`manifest.json`:
```json
{
    "display_name": "Chub Gallery Scraper",
    "loading_order": 100,
    "requires": [],
    "optional": [],
    "js": "index.js",
    "css": "style.css"
}
```

`package.json`:
```json
{
    "private": true,
    "type": "module"
}
```

`index.js` (skeleton):
```js
import { extractRawImageUrls, generateFilename, resolveCollision, guessExtension } from './lib.js';

jQuery(async () => {
    // Extension initialization — wired up in Task 4
});
```

`style.css` (empty file — styled in Task 4).

`lib.js` (empty file — implemented in steps 4 and 8 below).

- [ ] **Step 2: Write failing tests for HTML extraction**

`tests/test-extract.js`:
```js
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
        const html = '<div style="background-image: url(\'https://example.com/bg.jpg\')"></div>';
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

    it('extracts img tags with double quotes', () => {
        const html = '<img src="https://example.com/dq.png">';
        const result = extractImagesFromHtml(html, 'description');
        assert.equal(result.length, 1);
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/test-extract.js`

Expected: All tests fail — `lib.js` exports nothing yet.

- [ ] **Step 4: Implement extraction functions in lib.js**

`lib.js`:
```js
const SITE_CHROME_PATTERNS = [
    'chub.ai/logo',
    'chub.ai/favicon',
    '/static/',
    'google-analytics',
    'googletagmanager',
];

export function isSiteChrome(url) {
    return SITE_CHROME_PATTERNS.some(pat => url.includes(pat));
}

export function extractImagesFromHtml(html, fieldName) {
    const results = [];
    const seen = new Set();

    function add(url, source) {
        if (!url || seen.has(url) || isSiteChrome(url)) return;
        seen.add(url);
        results.push({ url, source });
    }

    for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
        add(m[1], fieldName);
    }
    for (const m of html.matchAll(/url\(["']?(https?:\/\/[^"')\s]+)["']?\)/gi)) {
        add(m[1], fieldName);
    }
    for (const m of html.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
        add(m[1], fieldName);
    }
    for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|gif|webp|bmp|svg)/gi)) {
        add(m[0], fieldName);
    }

    return results;
}

export function extractRawImageUrls(node, galleryImageUrls = []) {
    const images = [];
    const seen = new Set();

    function add(url, source) {
        if (!url || seen.has(url) || isSiteChrome(url)) return;
        seen.add(url);
        images.push({ url, source });
    }

    add(node.avatar_url, 'avatar');
    add(node.max_res_url, 'card');

    const chubExt = node.extensions?.chub;
    if (chubExt?.background_image) {
        add(chubExt.background_image, 'background');
    }

    for (const url of galleryImageUrls) {
        add(url, 'gallery');
    }

    const description = node.description || '';
    if (description) {
        for (const img of extractImagesFromHtml(description, 'description')) {
            add(img.url, img.source);
        }
    }

    const definition = node.definition || {};
    const firstMsg = definition.first_message || definition.first_mes || '';
    if (firstMsg) {
        for (const img of extractImagesFromHtml(firstMsg, 'first_message')) {
            add(img.url, img.source);
        }
    }

    const greetings = definition.alternate_greetings || [];
    for (let i = 0; i < greetings.length; i++) {
        if (!greetings[i]) continue;
        for (const img of extractImagesFromHtml(greetings[i], `greeting_${i + 1}`)) {
            add(img.url, img.source);
        }
    }

    const defChubExt = definition.extensions?.chub;
    if (defChubExt?.background_image) {
        add(defChubExt.background_image, 'background');
    }

    return images;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/test-extract.js`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add manifest.json package.json lib.js index.js style.css tests/test-extract.js
git commit -m "feat: image URL extraction from chub API responses

Implements extractRawImageUrls and extractImagesFromHtml covering
all 5 image sources: avatar, card, background, gallery, and embedded
HTML (img tags, CSS backgrounds, markdown, bare URLs). Includes
site chrome filtering and URL dedup."
```

---

### Task 2: Filename Generation and Content Dedup

**Files:**
- Modify: `lib.js` (add exports)
- Create: `tests/test-naming.js`

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: `guessExtension(url: string, contentType: string) → string`
- Produces: `generateFilename(source: string, sourceCounters: Map<string,number>, ext: string) → string`
- Produces: `resolveCollision(filename: string, existingNames: Set<string>, contentHash: string) → string`

- [ ] **Step 1: Write failing tests**

`tests/test-naming.js`:
```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/test-naming.js`

Expected: All tests fail — functions not exported from `lib.js` yet.

- [ ] **Step 3: Implement naming functions in lib.js**

Add to the end of `lib.js`:

```js
const MIME_TO_EXT = {
    'image/webp': '.webp',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
};

const IMAGE_EXTENSIONS = new Set(Object.values(MIME_TO_EXT));

export function guessExtension(url, contentType) {
    if (contentType) {
        const mime = contentType.split(';')[0].trim().toLowerCase();
        if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
    }
    if (url) {
        try {
            const pathname = new URL(url).pathname;
            const ext = pathname.substring(pathname.lastIndexOf('.')).toLowerCase();
            if (IMAGE_EXTENSIONS.has(ext)) return ext;
        } catch { /* invalid URL — fall through */ }
    }
    return '.bin';
}

const SINGULAR_SOURCES = new Set(['avatar', 'card', 'background']);

export function generateFilename(source, sourceCounters, ext) {
    if (SINGULAR_SOURCES.has(source)) {
        return `${source}${ext}`;
    }
    const count = (sourceCounters.get(source) || 0) + 1;
    sourceCounters.set(source, count);
    return `${source}_${String(count).padStart(2, '0')}${ext}`;
}

export function resolveCollision(filename, existingNames, contentHash) {
    if (!existingNames.has(filename)) return filename;
    const dotIdx = filename.lastIndexOf('.');
    const base = filename.substring(0, dotIdx);
    const ext = filename.substring(dotIdx);
    return `${base}_${contentHash.substring(0, 8)}${ext}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/test-naming.js`

Expected: All tests pass.

- [ ] **Step 5: Run all tests together**

Run: `node --test tests/test-extract.js tests/test-naming.js`

Expected: All tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add lib.js tests/test-naming.js
git commit -m "feat: filename generation with collision avoidance

Source-tagged naming (avatar.ext, gallery_01.ext, etc), MIME/URL-based
extension guessing, and hash-suffix collision resolution. Guarantees
unique filenames without using original source filenames."
```

---

### Task 3: Chub API Client and ST Gallery Integration

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: `extractRawImageUrls(node, galleryUrls)` from `lib.js`
- Consumes: `guessExtension(url, contentType)` from `lib.js`
- Consumes: `generateFilename(source, counters, ext)` from `lib.js`
- Consumes: `resolveCollision(filename, existingNames, hash)` from `lib.js`
- Produces: `fetchAndImportImages(chubFullPath, galleryFolder) → {added: number, skipped: number, failed: number}`

**Note:** This task requires SillyTavern running locally for manual testing. The CORS proxy mechanism should be confirmed against the ST source — check for `/api/cors`, a `corsFetch` utility, or similar patterns in `public/scripts/extensions/`.

- [ ] **Step 1: Implement CORS-proxied fetch wrapper**

In `index.js`, replace the skeleton content:

```js
import {
    extractRawImageUrls,
    guessExtension,
    generateFilename,
    resolveCollision,
} from './lib.js';

const CHUB_API = 'https://api.chub.ai/api/characters';
const CHUB_GALLERY_API = 'https://gateway.chub.ai/api/gallery/project';
const CHUB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function corsFetch(url, options = {}) {
    const headers = {
        ...getRequestHeaders(),
        ...options.headers,
    };
    const response = await fetch('/api/cors', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url, ...options }),
    });
    if (!response.ok) {
        throw new Error(`Fetch failed (${response.status}): ${url}`);
    }
    return response;
}

async function fetchCharacterFromChub(fullPath) {
    const url = `${CHUB_API}/${fullPath}?full=true`;
    const resp = await corsFetch(url);
    const data = await resp.json();
    return data.node || data;
}

async function fetchGalleryFromChub(projectId) {
    const url = `${CHUB_GALLERY_API}/${projectId}?limit=100&count=false`;
    try {
        const resp = await corsFetch(url);
        const data = await resp.json();
        return (data.nodes || [])
            .map(n => n.primary_image_path)
            .filter(Boolean);
    } catch {
        return [];
    }
}
```

Note: The `corsFetch` implementation above assumes ST exposes `POST /api/cors` with a JSON body containing the target `url`. If ST uses a different mechanism (query param, different endpoint, or a JS utility function), adjust accordingly. Check `SillyTavern/public/scripts/extensions/` and `SillyTavern/src/endpoints/` for the actual pattern.

- [ ] **Step 2: Implement SHA-256 hashing and existing gallery hash collection**

Add to `index.js`:

```js
async function hashContent(arrayBuffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function getExistingGalleryHashes(galleryFolder) {
    const listResp = await fetch('/api/images/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ folder: galleryFolder }),
    });
    if (!listResp.ok) return { hashes: new Set(), filenames: new Set() };

    const fileList = await listResp.json();
    const hashes = new Set();
    const filenames = new Set();

    for (const filePath of fileList) {
        const name = filePath.split('/').pop().split('\\').pop();
        filenames.add(name);

        try {
            const imgResp = await fetch(filePath);
            if (!imgResp.ok) continue;
            const buffer = await imgResp.arrayBuffer();
            hashes.add(await hashContent(buffer));
        } catch {
            // Can't hash this image — skip dedup for it
        }
    }

    return { hashes, filenames };
}
```

- [ ] **Step 3: Implement image download and gallery upload**

Add to `index.js`:

```js
async function downloadImage(url) {
    const resp = await corsFetch(url);
    const contentType = resp.headers.get('content-type') || '';
    const buffer = await resp.arrayBuffer();
    return { buffer, contentType };
}

async function uploadToGallery(base64Data, format, galleryFolder, filename) {
    const resp = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: galleryFolder,
            filename: filename,
        }),
    });
    if (!resp.ok) {
        throw new Error(`Upload failed (${resp.status}): ${filename}`);
    }
    return resp;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
```

- [ ] **Step 4: Implement main orchestration function**

Add to `index.js`:

```js
async function fetchAndImportImages(chubFullPath, galleryFolder, onProgress) {
    onProgress('Fetching character data from Chub...');

    const node = await fetchCharacterFromChub(chubFullPath);

    let galleryUrls = [];
    if (node.hasGallery && node.id) {
        onProgress('Fetching gallery...');
        galleryUrls = await fetchGalleryFromChub(node.id);
    }

    const imageEntries = extractRawImageUrls(node, galleryUrls);
    if (imageEntries.length === 0) {
        return { added: 0, skipped: 0, failed: 0, total: 0 };
    }

    onProgress(`Found ${imageEntries.length} image(s). Checking existing gallery...`);
    const { hashes: existingHashes, filenames: existingNames } =
        await getExistingGalleryHashes(galleryFolder);

    const batchHashes = new Set();
    const sourceCounters = new Map();
    let added = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < imageEntries.length; i++) {
        const entry = imageEntries[i];
        onProgress(`Importing ${i + 1}/${imageEntries.length}...`);

        try {
            const { buffer, contentType } = await downloadImage(entry.url);
            const contentHash = await hashContent(buffer);

            if (existingHashes.has(contentHash) || batchHashes.has(contentHash)) {
                skipped++;
                continue;
            }
            batchHashes.add(contentHash);

            const ext = guessExtension(entry.url, contentType);
            let filename = generateFilename(entry.source, sourceCounters, ext);
            filename = resolveCollision(filename, existingNames, contentHash);
            existingNames.add(filename);

            const base64 = arrayBufferToBase64(buffer);
            const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));
            const formatWithoutDot = ext.substring(1);

            await uploadToGallery(base64, formatWithoutDot, galleryFolder, nameWithoutExt);
            added++;
        } catch (err) {
            console.error(`[Chub Gallery] Failed: ${entry.url}`, err);
            failed++;
        }
    }

    return { added, skipped, failed, total: imageEntries.length };
}
```

- [ ] **Step 5: Verify corsFetch works against Chub API**

With SillyTavern running, open browser console and test:

```js
// Paste in console to test (adjust path to a known chub character):
const resp = await fetch('/api/cors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getRequestHeaders() },
    body: JSON.stringify({ url: 'https://api.chub.ai/api/characters/Anonymous/example-char?full=true' }),
});
console.log(resp.status, await resp.json());
```

If this fails, investigate ST's actual CORS proxy mechanism and update `corsFetch` accordingly.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: chub API client and ST gallery integration

CORS-proxied fetch for chub character and gallery APIs, SHA-256
content dedup against existing gallery, sequential upload with
source-tagged filenames and collision avoidance."
```

---

### Task 4: UI and Wiring

**Files:**
- Modify: `index.js` (add jQuery init, button injection, event handling)
- Modify: `style.css` (button and status styling)

**Interfaces:**
- Consumes: `fetchAndImportImages(fullPath, folder, onProgress)` from Task 3
- Consumes: ST globals: `getContext()`, `getRequestHeaders()`, `extension_settings`

- [ ] **Step 1: Add button and status CSS**

`style.css`:
```css
.chub-fetch-btn {
    font-size: 0.75rem;
    padding: 3px 8px;
    border: 1px solid var(--SmartThemeBorderColor, #555);
    border-radius: 3px;
    background: var(--SmartThemeBlurTintColor, #2a2a4a);
    color: var(--SmartThemeBodyColor, #ccc);
    cursor: pointer;
    transition: opacity 0.2s;
}

.chub-fetch-btn:hover:not(:disabled) {
    opacity: 0.8;
}

.chub-fetch-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
}

.chub-status {
    font-size: 0.7rem;
    color: var(--SmartThemeBodyColor, #999);
    opacity: 0.7;
    margin-top: 2px;
    min-height: 1em;
}
```

- [ ] **Step 2: Implement extension initialization and button injection**

Update the `jQuery(async () => { ... })` block in `index.js`:

```js
const extensionName = 'chub-gallery-scraper';

function getChubFullPath() {
    const context = getContext();
    const char = context?.characters?.[context?.characterId];
    return char?.data?.extensions?.chub?.full_path || '';
}

function getGalleryFolder() {
    const context = getContext();
    const char = context?.characters?.[context?.characterId];
    if (!char) return '';
    const folders = extension_settings?.gallery?.folders || {};
    return folders[char.avatar] || char.name || '';
}

function updateButtonState() {
    const btn = document.getElementById('chub_fetch_btn');
    if (!btn) return;
    const hasChub = !!getChubFullPath();
    btn.disabled = !hasChub;
    btn.title = hasChub
        ? 'Fetch images from Chub.ai'
        : 'No Chub origin detected for this character';
}

async function onFetchClick() {
    const btn = document.getElementById('chub_fetch_btn');
    const status = document.getElementById('chub_fetch_status');
    const fullPath = getChubFullPath();
    const folder = getGalleryFolder();

    if (!fullPath || !folder) return;

    btn.disabled = true;
    try {
        const result = await fetchAndImportImages(fullPath, folder, (msg) => {
            status.textContent = msg;
        });

        const parts = [];
        if (result.added > 0) parts.push(`Added ${result.added} new image${result.added === 1 ? '' : 's'}`);
        if (result.skipped > 0) parts.push(`${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped`);
        if (result.failed > 0) parts.push(`${result.failed} failed`);
        if (result.total === 0) parts.push('No images found on Chub');

        status.textContent = parts.join(', ');
    } catch (err) {
        console.error(`[Chub Gallery] Error:`, err);
        status.textContent = `Error: ${err.message}`;
    } finally {
        updateButtonState();
    }
}

jQuery(async () => {
    const buttonHtml = `
        <div id="chub_gallery_scraper_container" style="margin: 4px 0;">
            <button id="chub_fetch_btn" class="chub-fetch-btn" disabled>
                Fetch Chub Images
            </button>
            <div id="chub_fetch_status" class="chub-status"></div>
        </div>
    `;

    // Inject into gallery panel — the selector targets the gallery extension's
    // container. If the gallery panel structure differs in your ST version,
    // adjust the selector. Common locations:
    //   #gallery_pane .gallery_toolbar
    //   #form_character_gallery .gallery-controls
    const galleryContainer = $('#gallery_pane, #form_character_gallery').first();
    if (galleryContainer.length) {
        galleryContainer.prepend(buttonHtml);
    } else {
        // Fallback: append to the extensions panel
        $('#extensions_settings').append(buttonHtml);
    }

    document.getElementById('chub_fetch_btn')?.addEventListener('click', onFetchClick);

    // Update button state when character changes
    const eventSource = getContext()?.eventSource;
    if (eventSource) {
        eventSource.on('characterSelected', updateButtonState);
        eventSource.on('chatLoaded', updateButtonState);
    }

    updateButtonState();
});
```

Note: The gallery panel selectors above (`#gallery_pane`, `#form_character_gallery`) are best guesses. During testing, inspect the ST DOM to find the correct container and adjust the selector. The extension should work as long as the button is visible somewhere accessible.

- [ ] **Step 3: Manual end-to-end test**

With SillyTavern running and the extension folder copied to `extensions/third-party/chub-gallery-scraper/`:

1. Reload ST (F5 or restart)
2. Open a character that was imported from Chub — verify the "Fetch Chub Images" button is enabled
3. Switch to a non-Chub character — verify the button is greyed out and disabled
4. Switch back to the Chub character, click the button
5. Verify progress text updates during fetch
6. Verify images appear in the character's gallery
7. Click the button again — verify "X duplicates skipped" and no new images added
8. Check browser console for any errors

- [ ] **Step 4: Fix any issues found during manual testing**

Common issues to watch for:
- CORS proxy endpoint path may differ — check network tab for 404s
- Gallery panel selector may need adjustment — check DOM structure
- `getRequestHeaders()` or `getContext()` may not be global — check ST's module imports
- `extension_settings` vs `extensionSettings` capitalization
- Gallery list API may return relative vs absolute paths

- [ ] **Step 5: Commit**

```bash
git add index.js style.css
git commit -m "feat: UI button and end-to-end wiring

Small gallery panel button, greyed out for non-Chub characters.
Shows progress during fetch and summary on completion. Wires
all components together for the full scrape-and-import flow."
```
