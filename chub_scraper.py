#!/usr/bin/env python3
"""Download all character images from Chub.ai character card URLs."""

import argparse
import hashlib
import mimetypes
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

API_BASE = "https://api.chub.ai/api/characters"
GALLERY_API_BASE = "https://gateway.chub.ai/api/gallery/project"
SESSION = requests.Session()
SESSION.headers["User-Agent"] = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Domains used by chub for site chrome / UI — not character content
SITE_CHROME_PATTERNS = [
    "chub.ai/logo",
    "chub.ai/favicon",
    "/static/",
    "google-analytics",
    "googletagmanager",
]


def parse_chub_url(url: str) -> str:
    """Extract the 'creator/slug' path from a chub.ai character URL or bare path."""
    url = url.strip()
    m = re.match(r"https?://chub\.ai/characters/(.+?)/?$", url)
    if m:
        return m.group(1)
    # Allow bare creator/slug input
    if "/" in url and not url.startswith("http"):
        return url
    raise ValueError(f"Cannot parse chub URL: {url}")


def fetch_character(full_path: str) -> dict:
    """Fetch character data from the Chub API."""
    url = f"{API_BASE}/{full_path}?full=true"
    resp = SESSION.get(url, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data.get("node", data)


def fetch_gallery(project_id: int) -> list[str]:
    """Fetch gallery image URLs from the gateway API."""
    url = f"{GALLERY_API_BASE}/{project_id}?limit=100&count=false"
    try:
        resp = SESSION.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        return [
            node["primary_image_path"]
            for node in data.get("nodes", [])
            if node.get("primary_image_path")
        ]
    except requests.RequestException:
        return []


def resolve_url(url: str) -> str:
    """Follow redirects with a HEAD request and return the final URL."""
    try:
        resp = SESSION.head(url, allow_redirects=True, timeout=15)
        return resp.url
    except requests.RequestException:
        return url


def extract_image_urls(node: dict) -> list[dict]:
    """Extract all character-related image URLs from the API response.

    Returns a list of dicts with keys: url, source (description of where it came from).
    Deduplicates by both raw URL and resolved (post-redirect) URL.
    """
    images = []
    seen_raw = set()
    seen_resolved = set()

    def add(url: str, source: str):
        if not url or url in seen_raw:
            return
        if any(pat in url for pat in SITE_CHROME_PATTERNS):
            return
        seen_raw.add(url)

        final_url = resolve_url(url)
        if final_url in seen_resolved:
            return
        seen_resolved.add(final_url)

        images.append({"url": final_url, "source": source})

    # 1. Avatar
    add(node.get("avatar_url", ""), "avatar")

    # 2. High-res card image
    add(node.get("max_res_url", ""), "card")

    # 3. Background image from extensions
    chub_ext = (node.get("extensions") or {}).get("chub", {})
    if isinstance(chub_ext, dict):
        add(chub_ext.get("background_image", ""), "background")

    # 4. Gallery images (separate API)
    if node.get("hasGallery") and node.get("id"):
        for gallery_url in fetch_gallery(node["id"]):
            add(gallery_url, "gallery")

    # 5. Parse images from HTML content fields
    html_fields = [
        ("description", node.get("description", "")),
    ]

    # The definition contains first_mes, alternate_greetings, etc.
    definition = node.get("definition") or {}
    if isinstance(definition, dict):
        first_msg = definition.get("first_message") or definition.get("first_mes", "")
        if first_msg:
            html_fields.append(("first_message", first_msg))
        for i, greeting in enumerate(definition.get("alternate_greetings") or []):
            if greeting:
                html_fields.append((f"greeting_{i + 1}", greeting))
        # Also check the character book / extensions inside definition
        def_ext = (definition.get("extensions") or {}).get("chub", {})
        if isinstance(def_ext, dict):
            add(def_ext.get("background_image", ""), "background")

    for field_name, html in html_fields:
        if not html:
            continue
        _extract_images_from_html(html, field_name, add)

    return images


def _extract_images_from_html(html: str, field_name: str, add):
    """Extract image URLs from HTML content (img tags + CSS background-image)."""
    soup = BeautifulSoup(html, "html.parser")

    # <img> tags
    for img in soup.find_all("img"):
        src = img.get("src", "")
        if src:
            add(src, f"{field_name} (img tag)")

    # CSS background-image in style attributes
    for el in soup.find_all(style=True):
        style = el["style"]
        for m in re.finditer(r"url\(['\"]?(https?://[^'\")\s]+)['\"]?\)", style):
            add(m.group(1), f"{field_name} (css background)")

    # Also scan raw text for image URLs that might be in markdown
    for m in re.finditer(r"!\[[^\]]*\]\((https?://[^)\s]+)\)", html):
        add(m.group(1), f"{field_name} (markdown image)")

    # Bare URLs that look like images
    for m in re.finditer(r"https?://[^\s\"'<>]+\.(?:png|jpg|jpeg|gif|webp|bmp|svg)", html, re.IGNORECASE):
        add(m.group(0), f"{field_name} (url)")


MIME_TO_EXT = {
    "image/webp": ".webp",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
}

IMAGE_EXTENSIONS = frozenset(MIME_TO_EXT.values())


def guess_extension(url: str, content_type: str | None) -> str:
    """Guess file extension from content-type header, then URL path."""
    if content_type:
        mime = content_type.split(";")[0].strip().lower()
        if mime in MIME_TO_EXT:
            return MIME_TO_EXT[mime]

    path = urlparse(url).path
    ext = Path(path).suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        return ext

    return ".bin"


HAS_CURL = shutil.which("curl") is not None


def _curl_download(url: str) -> bytes | None:
    """Fallback downloader using curl subprocess for hosts that reject Python's TLS."""
    if not HAS_CURL:
        return None
    try:
        result = subprocess.run(
            ["curl", "-sL", "--max-time", "30", "-o", "-", url],
            capture_output=True, timeout=35,
        )
        if result.returncode == 0 and result.stdout:
            return result.stdout
    except Exception:
        pass
    return None


def download_image(
    url: str, output_dir: Path, index: int, source: str, seen_hashes: set[str] | None = None,
) -> tuple[Path | None, bool]:
    """Download a single image and save it to output_dir.

    Returns (filepath, is_duplicate).  filepath is None on failure.
    If the content hash was already seen, the file is deleted and is_duplicate=True.
    """
    content_type = ""
    image_data = None

    try:
        resp = SESSION.get(url, timeout=30)
        resp.raise_for_status()
        content_type = resp.headers.get("content-type", "")
        image_data = resp.content
    except requests.RequestException:
        image_data = _curl_download(url)
        if image_data is None:
            print(f"  FAILED: {url}")
            return None, False

    ext = guess_extension(url, content_type)

    safe_source = re.sub(r"[^\w\-]", "_", source)
    filename = f"{index:02d}_{safe_source}{ext}"
    filepath = output_dir / filename

    if filepath.exists():
        url_hash = hashlib.md5(url.encode()).hexdigest()[:8]
        filename = f"{index:02d}_{safe_source}_{url_hash}{ext}"
        filepath = output_dir / filename

    hasher = hashlib.sha256()
    hasher.update(image_data)
    with open(filepath, "wb") as f:
        f.write(image_data)

    content_hash = hasher.hexdigest()
    if seen_hashes is not None and content_hash in seen_hashes:
        filepath.unlink()
        return None, True
    if seen_hashes is not None:
        seen_hashes.add(content_hash)

    size_kb = filepath.stat().st_size / 1024
    print(f"  [{index:02d}] {filename} ({size_kb:.1f} KB) — {source}")
    return filepath, False


def make_safe_dirname(name: str, fallback: str) -> str:
    safe = re.sub(r"[^\w\- ]", "", name).strip().replace(" ", "_")
    return safe if safe else fallback.replace("/", "_")


def process_character(url: str, base_output: Path, on_progress=None):
    """Process a single character URL: fetch data, extract images, download them.

    on_progress(msg): optional callback for each status update line.
    Returns dict with results summary.
    """
    def log(msg):
        if on_progress:
            on_progress(msg)
        print(msg)

    full_path = parse_chub_url(url)
    log(f"Fetching: {full_path}")

    node = fetch_character(full_path)
    char_name = node.get("name", full_path.split("/")[-1])
    safe_name = make_safe_dirname(char_name, full_path)
    avatar_url = node.get("avatar_url", "")

    images = extract_image_urls(node)
    if not images:
        log(f"No images found for {char_name}")
        return {"name": char_name, "avatar": avatar_url, "downloaded": 0, "total": 0, "dir": ""}

    log(f"Found {len(images)} image(s) for: {char_name}")

    output_dir = base_output / safe_name
    output_dir.mkdir(parents=True, exist_ok=True)

    downloaded = 0
    duplicates = 0
    seen_hashes: set[str] = set()
    for i, img in enumerate(images, 1):
        filepath, is_dup = download_image(img["url"], output_dir, i, img["source"], seen_hashes)
        if is_dup:
            duplicates += 1
            log(f"[{i}/{len(images)}] skipped duplicate ({img['source']})")
        elif filepath:
            downloaded += 1
            log(f"[{i}/{len(images)}] {filepath.name}")

    summary = f"Downloaded {downloaded}/{len(images)} images"
    if duplicates:
        summary += f" ({duplicates} duplicate(s) skipped)"
    log(f"{summary} — {output_dir}")
    return {
        "name": char_name,
        "avatar": avatar_url,
        "downloaded": downloaded,
        "duplicates": duplicates,
        "total": len(images),
        "dir": str(output_dir),
    }


def main():
    parser = argparse.ArgumentParser(
        description="Download character images from Chub.ai",
        epilog="Examples:\n"
        "  python chub_scraper.py https://chub.ai/characters/User/my-char-abc123\n"
        "  python chub_scraper.py User/my-char-abc123 AnotherUser/other-char-def456\n"
        "  python chub_scraper.py -o ./my_images urls.txt\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "urls",
        nargs="+",
        help="Chub character URLs, creator/slug paths, or a .txt file with one URL per line",
    )
    parser.add_argument(
        "-o", "--output",
        default="./downloads",
        help="Output directory (default: ./downloads)",
    )
    args = parser.parse_args()

    output = Path(args.output)

    # Expand .txt files into individual URLs
    urls = []
    for u in args.urls:
        if u.endswith(".txt") and Path(u).is_file():
            urls.extend(line.strip() for line in Path(u).read_text().splitlines() if line.strip() and not line.startswith("#"))
        else:
            urls.append(u)

    if not urls:
        print("No URLs provided.")
        sys.exit(1)

    print(f"Processing {len(urls)} character(s)...")

    for url in urls:
        try:
            process_character(url, output)
        except Exception as e:
            print(f"  ERROR processing {url}: {e}")

    print("\nDone.")


if __name__ == "__main__":
    main()
