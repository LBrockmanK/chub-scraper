#!/usr/bin/env python3
"""Web UI for Chub image scraper."""

import json
import os
import queue
import threading
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, Response, jsonify, render_template_string, request

from chub_scraper import parse_chub_url, process_character

app = Flask(__name__)

DOWNLOADS_DIR = Path.home() / "Downloads" / "chub-images"

jobs: dict[str, queue.Queue] = {}

HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chub Image Scraper</title>
<style>
  :root {
    --bg: #1a1a2e;
    --surface: #16213e;
    --surface2: #0f3460;
    --accent: #e94560;
    --accent-hover: #ff6b81;
    --text: #eee;
    --text-dim: #999;
    --success: #2ecc71;
    --border: #2a2a4a;
    --card-bg: #1e2746;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  h1 {
    margin: 2rem 0 0.5rem;
    font-size: 1.8rem;
    letter-spacing: -0.5px;
  }
  h1 span { color: var(--accent); }
  .subtitle {
    color: var(--text-dim);
    font-size: 0.9rem;
    margin-bottom: 1.5rem;
  }
  .subtitle code {
    background: var(--surface);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.85rem;
  }
  .container {
    width: 100%;
    max-width: 720px;
    padding: 0 1rem;
  }
  textarea {
    width: 100%;
    min-height: 160px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 12px;
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 0.9rem;
    resize: vertical;
    outline: none;
    transition: border-color 0.2s;
  }
  textarea:focus { border-color: var(--accent); }
  textarea::placeholder { color: var(--text-dim); }
  .actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.75rem;
    align-items: center;
  }
  button {
    background: var(--accent);
    color: #fff;
    border: none;
    padding: 10px 24px;
    border-radius: 6px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s, transform 0.1s;
  }
  button:hover:not(:disabled) { background: var(--accent-hover); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .open-btn {
    background: var(--surface2);
    font-size: 0.85rem;
    padding: 8px 16px;
  }
  .open-btn:hover:not(:disabled) { background: #1a4a7a; }
  .status {
    margin-top: 0.5rem;
    font-size: 0.85rem;
    color: var(--text-dim);
    min-height: 1.2em;
  }

  #results {
    margin-top: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-bottom: 2rem;
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .card img {
    width: 48px;
    height: 48px;
    border-radius: 6px;
    object-fit: cover;
    flex-shrink: 0;
    background: var(--surface);
  }
  .card-info { flex: 1; min-width: 0; }
  .card-name {
    font-weight: 600;
    font-size: 0.95rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-detail {
    font-size: 0.8rem;
    color: var(--text-dim);
    margin-top: 2px;
  }
  .card-detail.ok { color: var(--success); }
  .card-detail.err { color: var(--accent); }

  #log {
    margin-top: 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    font-family: 'Consolas', monospace;
    font-size: 0.8rem;
    max-height: 220px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--text-dim);
    display: none;
  }
  #log.visible { display: block; }
  .toggle-log {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 0.8rem;
    padding: 4px 12px;
    margin-left: auto;
  }
  .toggle-log:hover { border-color: var(--text-dim); color: var(--text); }
</style>
</head>
<body>
<h1><span>Chub</span> Image Scraper</h1>
<p class="subtitle">Saves to <code id="dest"></code></p>
<div class="container">
  <textarea id="urls" placeholder="Paste one or more chub.ai character URLs (one per line)&#10;&#10;https://chub.ai/characters/User/character-name-abc123&#10;https://chub.ai/characters/User2/another-char-def456"></textarea>
  <div class="actions">
    <button id="go" onclick="startDownload()">Download Images</button>
    <button class="open-btn" onclick="openFolder()">Open Folder</button>
    <button class="toggle-log" onclick="toggleLog()">Log</button>
  </div>
  <div class="status" id="status"></div>
  <div id="log"></div>
  <div id="results"></div>
</div>
<script>
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const resultsEl = document.getElementById('results');
const goBtn = document.getElementById('go');

fetch('/api/config').then(r => r.json()).then(c => {
  document.getElementById('dest').textContent = c.download_dir;
});

function toggleLog() {
  logEl.classList.toggle('visible');
}

function appendLog(line) {
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function addCard(r) {
  const card = document.createElement('div');
  card.className = 'card';
  const ok = r.downloaded > 0;
  card.innerHTML = `
    ${r.avatar ? `<img src="${r.avatar}" alt="">` : ''}
    <div class="card-info">
      <div class="card-name">${esc(r.name)}</div>
      <div class="card-detail ${ok ? 'ok' : 'err'}">${
        ok ? `${r.downloaded} image${r.downloaded === 1 ? '' : 's'} saved` + (r.duplicates ? ` (${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} skipped)` : '')
           : (r.error || 'No images found')
      }</div>
    </div>
  `;
  resultsEl.prepend(card);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function startDownload() {
  const raw = document.getElementById('urls').value.trim();
  if (!raw) return;
  const urls = raw.split('\n').map(s => s.trim()).filter(Boolean);
  if (urls.length === 0) return;

  goBtn.disabled = true;
  statusEl.textContent = `Processing ${urls.length} URL(s)...`;
  logEl.textContent = '';

  fetch('/api/scrape', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({urls})
  })
  .then(r => r.json())
  .then(data => {
    const es = new EventSource('/api/stream/' + data.job_id);
    es.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'log') {
        appendLog(msg.text);
        statusEl.textContent = msg.text;
      } else if (msg.type === 'result') {
        addCard(msg.data);
      } else if (msg.type === 'done') {
        es.close();
        goBtn.disabled = false;
        statusEl.textContent = `Finished - ${msg.total} character(s) processed.`;
      }
    };
    es.onerror = () => {
      es.close();
      goBtn.disabled = false;
      statusEl.textContent = 'Connection lost.';
    };
  })
  .catch(err => {
    goBtn.disabled = false;
    statusEl.textContent = 'Request failed: ' + err;
  });
}

function openFolder() {
  fetch('/api/open-folder', {method: 'POST'});
}
</script>
</body>
</html>
"""


@app.route("/")
def index():
    return render_template_string(HTML)


@app.route("/api/config")
def config():
    return jsonify({"download_dir": str(DOWNLOADS_DIR)})


@app.route("/api/scrape", methods=["POST"])
def scrape():
    data = request.get_json()
    urls = data.get("urls", [])
    job_id = uuid.uuid4().hex[:12]
    q: queue.Queue = queue.Queue()
    jobs[job_id] = q

    def run():
        total = 0
        for url in urls:
            url = url.strip()
            if not url:
                continue
            try:
                result = process_character(
                    url,
                    DOWNLOADS_DIR,
                    on_progress=lambda msg: q.put({"type": "log", "text": msg}),
                )
                q.put({"type": "result", "data": result})
                total += 1
            except Exception as e:
                name = url.split("/")[-1] if "/" in url else url
                q.put({"type": "log", "text": f"ERROR: {e}"})
                q.put({"type": "result", "data": {"name": name, "avatar": "", "downloaded": 0, "total": 0, "dir": "", "error": str(e)}})
                total += 1
        q.put({"type": "done", "total": total})

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/api/stream/<job_id>")
def stream(job_id):
    q = jobs.get(job_id)
    if not q:
        return "Not found", 404

    def generate():
        while True:
            msg = q.get()
            yield f"data: {json.dumps(msg)}\n\n"
            if msg.get("type") == "done":
                jobs.pop(job_id, None)
                break

    return Response(generate(), mimetype="text/event-stream")


@app.route("/api/open-folder", methods=["POST"])
def open_folder():
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    os.startfile(str(DOWNLOADS_DIR))
    return "", 204


def main():
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("PORT", 5000))
    print(f"Chub Image Scraper running at http://localhost:{port}")
    print(f"Saving images to: {DOWNLOADS_DIR}")
    webbrowser.open(f"http://localhost:{port}")
    app.run(host="127.0.0.1", port=port, debug=False)


if __name__ == "__main__":
    main()
