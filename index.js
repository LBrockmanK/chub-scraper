import {
    extractRawImageUrls,
    guessExtension,
    generateFilename,
    resolveCollision,
} from './lib.js';

const CHUB_API = 'https://api.chub.ai/api/characters';
const CHUB_GALLERY_API = 'https://gateway.chub.ai/api/gallery/project';

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
        body: JSON.stringify({ folder: galleryFolder }),
    });
    if (!listResp.ok) return { hashes: new Set(), filenames: new Set() };

    const fileList = await listResp.json();
    const hashes = new Set();
    const filenames = new Set();

    for (const file of fileList) {
        filenames.add(file);
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
            if (err instanceof CorsProxyDisabledError) throw err;
            console.error(`[Chub Gallery] Failed: ${entry.url}`, err);
            failed++;
        }
    }

    return { added, skipped, failed, total: imageEntries.length };
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
            if (result.added > 0) parts.push(`${result.added} added`);
            if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
            if (result.failed > 0) parts.push(`${result.failed} failed`);
            if (result.total === 0) parts.push('No images on Chub');

            toastr.info(parts.join(', '), 'Chub Gallery Scraper');

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
