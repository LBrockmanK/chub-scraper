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
    for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|gif|webp|bmp|svg|avif)(?=[?#\s"'<>)]|$)/gi)) {
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

    if (node.max_res_url) {
        add(node.max_res_url, 'card');
    } else {
        add(node.avatar_url, 'avatar');
    }

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

const EXT_ALIASES = { '.jpeg': '.jpg' };

function extFromMagicBytes(buffer) {
    if (!buffer || buffer.byteLength < 12) return null;
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return '.png';
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return '.jpg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return '.gif';
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return '.bmp';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return '.webp';
    const str4to12 = String.fromCharCode(...bytes.slice(4, 12));
    if (str4to12.includes('ftyp') && (str4to12.includes('avif') || str4to12.includes('avis'))) return '.avif';
    return null;
}

export function guessExtension(url, contentType, buffer) {
    if (contentType) {
        const mime = contentType.split(';')[0].trim().toLowerCase();
        if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
    }
    if (url) {
        try {
            const pathname = new URL(url).pathname;
            const raw = pathname.substring(pathname.lastIndexOf('.')).toLowerCase();
            const ext = EXT_ALIASES[raw] || raw;
            if (IMAGE_EXTENSIONS.has(ext)) return ext;
        } catch { /* invalid URL */ }
    }
    return extFromMagicBytes(buffer) || '.bin';
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

/**
 * Extensions SillyTavern's MEDIA_EXTENSIONS allowlist accepts (src/constants.js).
 *
 * Only /api/images/upload gates on this list — it validates the `format` field
 * against it, so anything absent is rejected outright. Notably absent: avif, svg.
 *
 * /api/images/list does NOT use this list. It filters by mime category via a
 * `type` bitflag (see MEDIA_TYPE_IMAGE_AND_VIDEO in index.js), which is why a
 * listing must opt into video to see converted .webm files at all. Conflating
 * the two gates is how converted clips once became invisible to dedup.
 */
export const ST_MEDIA_EXTENSIONS = new Set([
    '.bmp', '.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp',
    '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.3gp', '.mkv', '.mpg',
]);

/**
 * The video entries within ST_MEDIA_EXTENSIONS. This extension can only ever produce
 * still images or converted WebM as *downloads* of source bytes — it never downloads
 * video — so a file with one of these extensions can never content-hash-match anything
 * this extension fetches. Hashing it would be wasted work.
 */
export const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.3gp', '.mkv', '.mpg',
]);

/** True for formats we both need to convert and know how to convert. */
export function needsConversion(ext) {
    return ext === '.avif';
}

/** Insert a content-hash marker before the extension. */
export function appendHashMarker(filename, marker) {
    const dotIdx = filename.lastIndexOf('.');
    const base = filename.substring(0, dotIdx);
    const ext = filename.substring(dotIdx);
    return `${base}_${marker}${ext}`;
}

/**
 * Cross-run dedup for converted images.
 *
 * A converted file's bytes never hash to its source's hash, so the source hash
 * rides along in the filename instead. The marker must end the stem (the part of
 * the filename before the final extension) — anything before an earlier dot in a
 * user-added file like `clip_a1b2c3d4.old.mp4` does not count as a match.
 */
export function filenamesContainMarker(filenames, marker) {
    const suffix = `_${marker}`;
    for (const name of filenames) {
        const dot = name.lastIndexOf('.');
        const stem = dot === -1 ? name : name.slice(0, dot);
        if (stem.endsWith(suffix)) return true;
    }
    return false;
}
