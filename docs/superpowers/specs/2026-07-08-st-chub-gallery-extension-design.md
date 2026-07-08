# SillyTavern Chub Gallery Scraper Extension — Design Spec

## Overview

A SillyTavern third-party extension that fetches all images associated with a character from Chub.ai and adds them to the character's ST gallery. Pure client-side JavaScript — no server plugin or external dependencies.

## Constraints

- **Append-only:** The extension never deletes or overwrites existing gallery images. It only adds new ones.
- **Manual trigger:** A button click initiates the fetch. No automatic behavior.
- **Auto-detect only:** The extension reads the chub origin from `character.data.extensions.chub.full_path`. No manual URL input.

## Extension Structure

```
SillyTavern/public/scripts/extensions/third-party/chub-gallery-scraper/
  manifest.json    — extension metadata, declares gallery dependency
  index.js         — all extension logic
  style.css        — button and status line styling
```

Standard ST third-party extension. Users install by cloning/copying the folder into `extensions/third-party/`.

## UI

- **One small button** in the gallery panel: "Fetch Chub Images"
- Always visible, but **greyed out and disabled** when the current character has no chub metadata
- **Status line** below the button for progress and results
- Button disables during fetch to prevent double-clicks
- No settings panel — nothing to configure

## Image Discovery Pipeline

When the user clicks the button:

1. Read `character.data.extensions.chub.full_path` (e.g., `"SecretApe/percylla-..."`)
2. Fetch character JSON from `https://api.chub.ai/api/characters/{full_path}?full=true` via ST's CORS proxy
3. Extract image URLs from all 5 sources:
   - **Avatar:** `node.avatar_url`
   - **Card image:** `node.max_res_url`
   - **Background:** `node.extensions.chub.background_image` (also check `definition.extensions.chub.background_image`)
   - **Gallery:** `GET https://gateway.chub.ai/api/gallery/project/{node.id}?limit=100` — only when `node.hasGallery` is true. Each entry's `primary_image_path` is an image URL.
   - **Embedded in HTML fields:** Parse `node.description`, `definition.first_message`, and `definition.alternate_greetings[]` for:
     - `<img>` tag `src` attributes
     - CSS `background-image: url(...)` in style attributes
     - Markdown image syntax `![alt](url)`
     - Bare image URLs (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg`)
4. Filter out site chrome URLs (chub logos, favicons, static assets, analytics)
5. Deduplicate by resolved URL (follow redirects via fetch HEAD, skip URLs already seen)

## Filename Handling

Characters on chub frequently reuse generic filenames like `image.png` across multiple embedded images. The extension never uses the original filename from the source URL.

**Source-tagged naming:** Each image is named by its source type and index:
- `avatar.ext`, `card.ext`, `background.ext`
- `gallery_01.ext`, `gallery_02.ext`, ...
- `description_01.ext`, `description_02.ext`, ...
- `first_message_01.ext`, ...
- `greeting_1_01.ext`, `greeting_2_01.ext`, ...

Extension is determined from the response `Content-Type` header, falling back to the URL path extension.

**Collision with existing gallery files:** Before uploading, list current gallery contents via `POST /api/images/list`. If a generated filename already exists, append a short content hash suffix (e.g., `gallery_01_a3f8.png`).

## Content Deduplication

After downloading each image's raw bytes:

1. Compute SHA-256 hash of the content
2. Compare against hashes of all existing gallery images (each existing image is fetched once at the start of the operation, hashed, then discarded) and against hashes of images already processed in this batch
3. If a content match exists anywhere, skip the image entirely

This guarantees clicking the button multiple times never creates duplicates.

## Gallery Folder Resolution

The target gallery folder is resolved using ST's built-in lookup:

```
extensionSettings.gallery.folders[character.avatar] ?? character.name
```

This is keyed by the avatar filename (which is unique per character), not the character name. This correctly handles characters with identical display names.

## Upload

Images are uploaded sequentially via ST's gallery API:

```
POST /api/images/upload
{
  image: <base64 encoded image data>,
  format: <file extension without dot>,
  ch_name: <gallery folder name>,
  filename: <generated filename without extension>
}
```

## Progress & Error Handling

- Status line updates per image: "Importing 3/7 images..."
- On completion: "Added 5 new images (2 duplicates skipped)"
- Individual image failures (network error, bad format) are logged but do not stop the batch
- Final summary notes any failures: "Added 4 new images, 1 failed"

## CORS

All requests to `api.chub.ai` and `gateway.chub.ai` go through ST's built-in CORS proxy to avoid browser CORS restrictions. The proxy endpoint is typically accessed via a utility function or `/api/cors?url=<encoded_url>` — the exact mechanism should be confirmed against the ST source during implementation. The Chub API requires a browser-like User-Agent header, which the CORS proxy preserves.

## Technical Notes

- The Chub character API requires `?full=true` to return definition fields
- The gallery API uses a separate gateway domain (`gateway.chub.ai`) from the main API (`api.chub.ai`)
- Some image hosts (e.g., catbox.moe) may have TLS issues — in-browser fetch generally handles this better than Python's requests library since it uses the OS TLS stack
- The `first_message` field name (not `first_mes`) is used in the raw API response; ST's internal representation may differ
