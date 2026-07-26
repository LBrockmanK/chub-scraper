import {
    extractRawImageUrls,
    guessExtension,
    generateFilename,
    resolveCollision,
    needsConversion,
    appendHashMarker,
    filenamesContainMarker,
    filenamesContainPoster,
    POSTER_SUFFIX,
    VIDEO_EXTENSIONS,
} from './lib.js';
import { convertAvif } from './avif.js';

const CHUB_API = 'https://api.chub.ai/api/characters';
const CHUB_GALLERY_API = 'https://gateway.chub.ai/api/gallery/project';

// SillyTavern's MEDIA_REQUEST_TYPE bitflags: IMAGE 0b001 | VIDEO 0b010.
// Converted clips are .webm, so the listing must include video or dedup can never see them.
const MEDIA_TYPE_IMAGE_AND_VIDEO = 3;

function stContext() {
    return SillyTavern.getContext();
}

class CorsProxyDisabledError extends Error {
    constructor() {
        super('CORS proxy is disabled. Set enableCorsProxy: true in config.yaml and restart SillyTavern.');
        this.name = 'CorsProxyDisabledError';
    }
}

async function corsFetch(url) {
    const response = await fetch(`/proxy/${encodeURIComponent(url)}`, {
        headers: stContext().getRequestHeaders(),
    });
    if (response.status === 404) {
        const text = await response.text();
        if (text.includes('CORS proxy is disabled')) {
            throw new CorsProxyDisabledError();
        }
    }
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
    } catch (err) {
        if (err instanceof CorsProxyDisabledError) throw err;
        return [];
    }
}

async function hashContent(arrayBuffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function getExistingGalleryHashes(galleryFolder) {
    const listResp = await fetch('/api/images/list', {
        method: 'POST',
        headers: stContext().getRequestHeaders(),
        body: JSON.stringify({ folder: galleryFolder, type: MEDIA_TYPE_IMAGE_AND_VIDEO }),
    });
    if (!listResp.ok) return { hashes: new Set(), filenames: new Set() };

    const fileList = await listResp.json();
    const hashes = new Set();
    const filenames = new Set();

    for (const file of fileList) {
        filenames.add(file);
        // Content-hash dedup only ever compares against files downloaded from Chub, and this
        // extension never downloads video (URL regex and MIME map only cover still formats), so
        // a video file's hash can never match anything. Skip the fetch-and-hash for it entirely —
        // its filename (added above) is all the marker-based dedup path needs.
        const dot = file.lastIndexOf('.');
        const ext = dot === -1 ? '' : file.slice(dot).toLowerCase();
        if (VIDEO_EXTENSIONS.has(ext)) continue;
        try {
            const imgResp = await fetch(`user/images/${galleryFolder}/${file}`);
            if (!imgResp.ok) continue;
            const buffer = await imgResp.arrayBuffer();
            hashes.add(await hashContent(buffer));
        } catch {
            // Can't hash this image — skip dedup for it
        }
    }

    return { hashes, filenames };
}

async function downloadImage(url) {
    const resp = await corsFetch(url);
    const contentType = resp.headers.get('content-type') || '';
    const buffer = await resp.arrayBuffer();
    return { buffer, contentType };
}

async function uploadToGallery(base64Data, format, galleryFolder, filename) {
    const resp = await fetch('/api/images/upload', {
        method: 'POST',
        headers: stContext().getRequestHeaders(),
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
        return { added: 0, skipped: 0, failed: 0, converted: 0, stills: 0, posters: 0, posterReasons: [], total: 0 };
    }

    onProgress(`Found ${imageEntries.length} image(s). Checking existing gallery...`);
    const { hashes: existingHashes, filenames: existingNames } =
        await getExistingGalleryHashes(galleryFolder);

    const batchHashes = new Set();
    const sourceCounters = new Map();
    let added = 0;
    let skipped = 0;
    let failed = 0;
    let converted = 0;
    let stills = 0;
    let posters = 0;
    const posterReasons = new Set();

    for (let i = 0; i < imageEntries.length; i++) {
        const entry = imageEntries[i];
        onProgress(`Importing ${i + 1}/${imageEntries.length}...`);

        try {
            const { buffer, contentType } = await downloadImage(entry.url);
            const contentHash = await hashContent(buffer);
            const sourceExt = guessExtension(entry.url, contentType, buffer);
            const marker = contentHash.substring(0, 8);
            const convert = needsConversion(sourceExt);

            // Converted files can never hash-match their source on disk, so they
            // dedup on the hash marker carried in the filename instead.
            const alreadyPresent = convert
                ? filenamesContainMarker(existingNames, marker)
                : existingHashes.has(contentHash);

            if (alreadyPresent || batchHashes.has(contentHash)) {
                skipped++;
                continue;
            }
            batchHashes.add(contentHash);

            let uploadBuffer = buffer;
            let uploadExt = sourceExt;
            let convertedKind = null;
            let isPoster = false;
            if (convert) {
                const result = await convertAvif(buffer, (frame, total) => {
                    onProgress(`Converting ${i + 1}/${imageEntries.length} (frame ${frame}/${total})...`);
                });
                uploadBuffer = result.buffer;
                uploadExt = result.ext;
                convertedKind = result.kind;
                // A retryable still is a degradation, not an answer. It gets a poster
                // marker so it never satisfies dedup, letting a later run in a capable
                // browser convert the clip properly.
                isPoster = result.retryable === true;
                if (isPoster) {
                    posterReasons.add(result.reason);
                    // At most one poster per source clip — otherwise a browser that can
                    // never convert would add a fresh one on every import.
                    if (filenamesContainPoster(existingNames, marker)) {
                        skipped++;
                        continue;
                    }
                }
            }

            let filename = generateFilename(entry.source, sourceCounters, uploadExt);
            if (convert) {
                filename = appendHashMarker(filename, isPoster ? `${marker}${POSTER_SUFFIX}` : marker);
            }
            filename = resolveCollision(filename, existingNames, contentHash);
            existingNames.add(filename);

            const base64 = arrayBufferToBase64(uploadBuffer);
            const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));
            const formatWithoutDot = uploadExt.substring(1);

            await uploadToGallery(base64, formatWithoutDot, galleryFolder, nameWithoutExt);
            added++;
            if (convertedKind === 'video') converted++;
            else if (isPoster) posters++;
            else if (convertedKind === 'still') stills++;
        } catch (err) {
            if (err instanceof CorsProxyDisabledError) throw err;
            console.error(`[Chub Gallery] Failed: ${entry.url}`, err);
            failed++;
        }
    }

    return {
        added, skipped, failed, converted, stills, posters,
        posterReasons: [...posterReasons],
        total: imageEntries.length,
    };
}

// --- UI ---

function getChubFullPath() {
    const context = stContext();
    const char = context.characters?.[context.characterId];
    return char?.data?.extensions?.chub?.full_path || '';
}

function getGalleryFolder() {
    const context = stContext();
    const char = context.characters?.[context.characterId];
    if (!char) return '';
    const folders = context.extensionSettings?.gallery?.folders || {};
    return folders[char.avatar] || char.name || '';
}

function closeGallery() {
    const closeBtn = document.querySelector('#gallery .dragClose');
    if (closeBtn) closeBtn.click();
}

function injectButton(galleryElement) {
    if (galleryElement.querySelector('#chub_fetch_btn')) return;

    const controlsContainer = galleryElement.querySelector('.dragTitle .flex-container.alignItemsCenter');
    if (!controlsContainer) return;

    const btn = document.createElement('div');
    btn.id = 'chub_fetch_btn';
    btn.classList.add('menu_button', 'menu_button_icon', 'interactable');
    btn.title = 'Fetch images from Chub.ai';
    btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down fa-fw"></i>';

    const hasChub = !!getChubFullPath();
    if (!hasChub) {
        btn.classList.add('disabled');
        btn.title = 'No Chub origin detected for this character';
    }

    let running = false;
    btn.addEventListener('click', async () => {
        if (running) return;
        const fullPath = getChubFullPath();
        const folder = getGalleryFolder();
        if (!fullPath || !folder || btn.classList.contains('disabled')) return;

        running = true;
        btn.classList.add('disabled');
        const icon = btn.querySelector('i');
        icon.classList.replace('fa-cloud-arrow-down', 'fa-spinner');
        icon.classList.add('fa-spin');
        try {
            const result = await fetchAndImportImages(fullPath, folder, (msg) => {
                btn.title = msg;
            });

            const parts = [];
            if (result.added > 0) {
                const detail = [];
                if (result.converted > 0) detail.push(`${result.converted} converted`);
                if (result.stills > 0) detail.push(`${result.stills} as still frames`);
                if (result.posters > 0) detail.push(`${result.posters} poster only`);
                parts.push(detail.length > 0
                    ? `${result.added} added (${detail.join(', ')})`
                    : `${result.added} added`);
            }
            if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
            if (result.failed > 0) parts.push(`${result.failed} failed`);
            if (result.total === 0) parts.push('No images on Chub');

            toastr.info(parts.join(', '), 'Chub Gallery Scraper');

            // A degraded conversion must not read as plain success. Say what happened,
            // why, and that a retry can still fix it.
            if (result.posters > 0) {
                toastr.warning(
                    `${result.posters} animated clip(s) could not be converted to video `
                    + `(${result.posterReasons.join(', ')}) — imported as a still frame instead. `
                    + 'Re-run the import to try again; these are not marked as done.',
                    'Chub Gallery Scraper',
                    { timeOut: 12000 },
                );
            }

            if (result.added > 0) {
                closeGallery();
            }
        } catch (err) {
            console.error('[Chub Gallery] Error:', err);
            toastr.error(err.message, 'Chub Gallery Scraper');
        } finally {
            running = false;
            btn.classList.remove('disabled');
            icon.classList.remove('fa-spin');
            icon.classList.replace('fa-spinner', 'fa-cloud-arrow-down');
            btn.title = 'Fetch images from Chub.ai';
        }
    });

    controlsContainer.appendChild(btn);
}

jQuery(async () => {
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node instanceof HTMLElement && node.id === 'gallery') {
                    injectButton(node);
                }
            }
        }
    });

    observer.observe(document.getElementById('movingDivs') || document.body, {
        childList: true,
        subtree: false,
    });

    const existing = document.getElementById('gallery');
    if (existing) {
        injectButton(existing);
    }
});
