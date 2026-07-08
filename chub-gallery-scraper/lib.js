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
