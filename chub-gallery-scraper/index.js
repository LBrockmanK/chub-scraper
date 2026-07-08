import {
    extractRawImageUrls,
    guessExtension,
    generateFilename,
    resolveCollision,
} from './lib.js';

const CHUB_API = 'https://api.chub.ai/api/characters';
const CHUB_GALLERY_API = 'https://gateway.chub.ai/api/gallery/project';

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

// --- UI (Task 4) ---

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

    const galleryContainer = $('#gallery_pane, #form_character_gallery').first();
    if (galleryContainer.length) {
        galleryContainer.prepend(buttonHtml);
    } else {
        $('#extensions_settings').append(buttonHtml);
    }

    document.getElementById('chub_fetch_btn')?.addEventListener('click', onFetchClick);

    const eventSource = getContext()?.eventSource;
    if (eventSource) {
        eventSource.on('characterSelected', updateButtonState);
        eventSource.on('chatLoaded', updateButtonState);
    }

    updateButtonState();
});
