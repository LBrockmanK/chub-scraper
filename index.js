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

async function corsFetch(url) {
    const response = await fetch(`/proxy/${encodeURIComponent(url)}`, {
        headers: stContext().getRequestHeaders(),
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

function injectButton(galleryElement) {
    if (galleryElement.querySelector('#chub_fetch_btn')) return;

    const topBar = galleryElement.querySelector('.flex-container.alignItemsCenter');
    if (!topBar) return;

    const btn = document.createElement('div');
    btn.id = 'chub_fetch_btn';
    btn.classList.add('right_menu_button');
    btn.title = 'Fetch images from Chub.ai';
    btn.innerHTML = '<span class="fa-solid fa-cloud-arrow-down fa-fw"></span>';

    const statusEl = document.createElement('span');
    statusEl.id = 'chub_fetch_status';
    statusEl.classList.add('chub-status');

    const hasChub = !!getChubFullPath();
    if (!hasChub) {
        btn.classList.add('disabled');
        btn.title = 'No Chub origin detected for this character';
    }

    btn.addEventListener('click', async () => {
        const fullPath = getChubFullPath();
        const folder = getGalleryFolder();
        if (!fullPath || !folder || btn.classList.contains('disabled')) return;

        btn.classList.add('disabled');
        try {
            const result = await fetchAndImportImages(fullPath, folder, (msg) => {
                statusEl.textContent = msg;
            });

            const parts = [];
            if (result.added > 0) parts.push(`${result.added} added`);
            if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
            if (result.failed > 0) parts.push(`${result.failed} failed`);
            if (result.total === 0) parts.push('No images on Chub');

            statusEl.textContent = parts.join(', ');
            toastr.info(parts.join(', '), 'Chub Gallery Scraper');
        } catch (err) {
            console.error('[Chub Gallery] Error:', err);
            statusEl.textContent = `Error: ${err.message}`;
            toastr.error(err.message, 'Chub Gallery Scraper');
        } finally {
            if (getChubFullPath()) {
                btn.classList.remove('disabled');
            }
        }
    });

    topBar.appendChild(btn);
    topBar.appendChild(statusEl);
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
