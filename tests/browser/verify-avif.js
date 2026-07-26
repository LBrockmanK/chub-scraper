/**
 * Browser-only acceptance check for AVIF conversion.
 *
 * WebCodecs does not exist in Node, so this path cannot be covered by the
 * node:test suite. Run it in a browser console from the extension folder:
 *
 *   const { verifyAvifConversion } = await import('./tests/browser/verify-avif.js');
 *   await verifyAvifConversion('https://waking-up-naked-next-to-a-verry-happy-elf.pages.dev');
 *
 * Returns a report object; `pass` is true when every assertion held.
 */

import { convertAvif } from '../../avif.js';

const CASES = [
    { file: 'g3.avif', expectFrames: 167, expectWidth: 608, expectHeight: 608, expectDurationMs: 5218.75 },
    { file: 'Ending_Puppy_24fps.avif', expectFrames: 131, expectWidth: 608, expectHeight: 608, expectDurationMs: 5458.25 },
    { file: 'G1_Roselle_32FPS_Part1_f0-156.avif', expectFrames: 157, expectWidth: 512, expectHeight: 768, expectDurationMs: 4906.25 },
];

const TOLERANCE_MS = 60;

/** Load a blob into a <video> and report what the browser makes of it. */
async function probeVideo(blob) {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;
    try {
        const metadata = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout waiting for metadata')), 10000);
            video.onerror = () => {
                clearTimeout(timer);
                reject(new Error(`video error: ${video.error?.message ?? 'unknown'}`));
            };
            video.onloadedmetadata = () => {
                clearTimeout(timer);
                resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
            };
        });

        // Seek to the middle and confirm the frame carries real image content,
        // which catches a container that parses but decodes to nothing.
        video.currentTime = metadata.duration / 2;
        await new Promise(resolve => {
            video.onseeked = resolve;
            setTimeout(resolve, 3000);
        });

        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 64, 64);
        const pixels = ctx.getImageData(0, 0, 64, 64).data;
        let nonBlank = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8) nonBlank++;
        }
        return { ...metadata, seekedTo: video.currentTime, nonBlank, sampled: 64 * 64 };
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function verifyAvifConversion(baseUrl) {
    const results = [];

    for (const testCase of CASES) {
        const failures = [];
        try {
            const response = await fetch(`${baseUrl}/${encodeURIComponent(testCase.file)}`);
            if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
            const source = await response.arrayBuffer();

            const started = performance.now();
            const converted = await convertAvif(source);
            const elapsedMs = Math.round(performance.now() - started);

            if (converted.kind !== 'video') failures.push(`kind was '${converted.kind}', expected 'video'`);
            if (converted.ext !== '.webm') failures.push(`ext was '${converted.ext}', expected '.webm'`);

            const probe = await probeVideo(new Blob([converted.buffer], { type: 'video/webm' }));
            if (Math.abs(probe.duration * 1000 - testCase.expectDurationMs) > TOLERANCE_MS) {
                failures.push(`duration ${probe.duration}s, expected ~${testCase.expectDurationMs}ms`);
            }
            if (probe.width !== testCase.expectWidth) failures.push(`width ${probe.width}, expected ${testCase.expectWidth}`);
            if (probe.height !== testCase.expectHeight) failures.push(`height ${probe.height}, expected ${testCase.expectHeight}`);
            if (probe.nonBlank < probe.sampled * 0.5) failures.push(`mid-seek frame mostly blank (${probe.nonBlank}/${probe.sampled})`);

            results.push({
                file: testCase.file,
                pass: failures.length === 0,
                failures,
                sourceBytes: source.byteLength,
                webmBytes: converted.buffer.byteLength,
                sizeRatio: +(converted.buffer.byteLength / source.byteLength).toFixed(2),
                elapsedMs,
                probe,
            });
        } catch (err) {
            results.push({ file: testCase.file, pass: false, failures: [...failures, String(err)] });
        }
    }

    return { pass: results.every(r => r.pass), results };
}
