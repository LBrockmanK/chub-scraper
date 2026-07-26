import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { vint, uint, float64, concatBytes, element, buildWebM } from '../webm.js';

const hex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');

describe('vint', () => {
    it('encodes small values in one byte', () => {
        assert.equal(hex(vint(0)), '80');
        assert.equal(hex(vint(1)), '81');
        assert.equal(hex(vint(126)), 'fe');
    });

    it('escalates at 127 because all-ones is reserved for unknown size', () => {
        // 0xFF would mean "unknown size", so 127 must widen to two bytes.
        assert.equal(hex(vint(127)), '40 7f');
        assert.equal(hex(vint(128)), '40 80');
    });

    it('uses two bytes up to the two-byte reserved value', () => {
        assert.equal(hex(vint(16382)), '7f fe');
    });

    it('escalates at 16383 for the same reason', () => {
        assert.equal(hex(vint(16383)), '20 3f ff');
    });
});

describe('uint', () => {
    it('encodes zero as a single byte', () => {
        assert.equal(hex(uint(0)), '00');
    });

    it('uses minimal width', () => {
        assert.equal(hex(uint(1)), '01');
        assert.equal(hex(uint(255)), 'ff');
        assert.equal(hex(uint(256)), '01 00');
    });

    it('encodes the TimecodeScale value', () => {
        assert.equal(hex(uint(1000000)), '0f 42 40');
    });
});

describe('float64', () => {
    it('round-trips through a DataView', () => {
        const bytes = float64(5218.75);
        assert.equal(bytes.length, 8);
        const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
        assert.equal(view.getFloat64(0), 5218.75);
    });
});

describe('concatBytes', () => {
    it('joins arrays in order', () => {
        const out = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])]);
        assert.equal(hex(out), '01 02 03');
    });

    it('returns an empty array for no input', () => {
        assert.equal(concatBytes([]).length, 0);
    });
});

describe('element', () => {
    it('frames id, size vint, then payload', () => {
        const out = element([0x86], new Uint8Array([0xAA, 0xBB]));
        assert.equal(hex(out), '86 82 aa bb');
    });

    it('handles multi-byte ids', () => {
        const out = element([0x2A, 0xD7, 0xB1], uint(1000000));
        assert.equal(hex(out), '2a d7 b1 83 0f 42 40');
    });
});

// --- Minimal EBML reader, test-only ---

function descriptorLength(firstByte) {
    let len = 1;
    for (let mask = 0x80; mask > 0; mask >>= 1) {
        if (firstByte & mask) break;
        len++;
    }
    return len;
}

function readId(buf, offset) {
    const len = descriptorLength(buf[offset]);
    let id = '';
    for (let i = 0; i < len; i++) id += buf[offset + i].toString(16).padStart(2, '0');
    return { id, len };
}

function readSize(buf, offset) {
    const len = descriptorLength(buf[offset]);
    let value = buf[offset] & (0xff >> len);
    for (let i = 1; i < len; i++) value = value * 256 + buf[offset + i];
    return { value, len };
}

/** Yields the direct children of a byte range. */
function* children(buf, start, end) {
    let offset = start;
    while (offset < end) {
        const { id, len: idLen } = readId(buf, offset);
        const { value: size, len: sizeLen } = readSize(buf, offset + idLen);
        const dataStart = offset + idLen + sizeLen;
        yield { id, size, data: buf.subarray(dataStart, dataStart + size) };
        offset = dataStart + size;
    }
}

const childrenOf = (data) => [...children(data, 0, data.length)];
const find = (data, id) => childrenOf(data).find(c => c.id === id);
const findAll = (data, id) => childrenOf(data).filter(c => c.id === id);
const readUint = (data) => data.reduce((acc, b) => acc * 256 + b, 0);
const readStr = (data) => new TextDecoder().decode(data);

// --- Fixtures ---

function fakeChunks(count, frameDurationUs, gop) {
    const chunks = [];
    for (let i = 0; i < count; i++) {
        chunks.push({
            data: new Uint8Array([i & 0xff, 0x55]),
            timestampUs: i * frameDurationUs,
            key: i % gop === 0,
        });
    }
    return chunks;
}

describe('buildWebM', () => {
    const FRAME_US = 31250; // 32 fps
    const build = () => buildWebM({
        width: 608,
        height: 608,
        frameDurationUs: FRAME_US,
        durationMs: 167 * FRAME_US / 1000,
        chunks: fakeChunks(167, FRAME_US, 64),
        codec: 'V_VP9',
    });

    it('throws when given no chunks', () => {
        assert.throws(
            () => buildWebM({ width: 8, height: 8, frameDurationUs: 1, durationMs: 1, chunks: [] }),
            /no chunks/,
        );
    });

    it('starts with an EBML header declaring DocType webm', () => {
        const top = childrenOf(build());
        assert.equal(top[0].id, '1a45dfa3');
        assert.equal(readStr(find(top[0].data, '4282').data), 'webm');
    });

    it('declares a 1ms TimecodeScale and the clip duration in Info', () => {
        const top = childrenOf(build());
        const segment = top.find(c => c.id === '18538067');
        const info = find(segment.data, '1549a966');
        assert.equal(readUint(find(info.data, '2ad7b1').data), 1000000);

        const durationBytes = find(info.data, '4489').data;
        const view = new DataView(durationBytes.buffer, durationBytes.byteOffset, 8);
        assert.equal(view.getFloat64(0), 5218.75);
    });

    it('declares one VP9 video track with the source dimensions', () => {
        const segment = childrenOf(build()).find(c => c.id === '18538067');
        const trackEntry = find(find(segment.data, '1654ae6b').data, 'ae');

        assert.equal(readUint(find(trackEntry.data, 'd7').data), 1);   // TrackNumber
        assert.equal(readUint(find(trackEntry.data, '83').data), 1);   // TrackType: video
        assert.equal(readStr(find(trackEntry.data, '86').data), 'V_VP9');
        assert.equal(readUint(find(trackEntry.data, '23e383').data), FRAME_US * 1000); // ns

        const video = find(trackEntry.data, 'e0');
        assert.equal(readUint(find(video.data, 'b0').data), 608);
        assert.equal(readUint(find(video.data, 'ba').data), 608);
    });

    it('honours a VP8 codec id', () => {
        const webm = buildWebM({
            width: 64, height: 64, frameDurationUs: FRAME_US, durationMs: 62.5,
            chunks: fakeChunks(2, FRAME_US, 64), codec: 'V_VP8',
        });
        const segment = childrenOf(webm).find(c => c.id === '18538067');
        const trackEntry = find(find(segment.data, '1654ae6b').data, 'ae');
        assert.equal(readStr(find(trackEntry.data, '86').data), 'V_VP8');
    });

    it('opens a new cluster at each keyframe', () => {
        const segment = childrenOf(build()).find(c => c.id === '18538067');
        const clusters = findAll(segment.data, '1f43b675');
        // 167 frames, keyframes at 0/64/128 => 3 clusters
        assert.equal(clusters.length, 3);
        assert.deepEqual(
            clusters.map(c => readUint(find(c.data, 'e7').data)),
            [0, 2000, 4000],
        );
    });

    it('writes every frame exactly once across all clusters', () => {
        const segment = childrenOf(build()).find(c => c.id === '18538067');
        const clusters = findAll(segment.data, '1f43b675');
        const blocks = clusters.flatMap(c => findAll(c.data, 'a3'));
        assert.equal(blocks.length, 167);
    });

    it('writes SimpleBlocks with track number, relative timestamp and keyframe flag', () => {
        const segment = childrenOf(build()).find(c => c.id === '18538067');
        const clusters = findAll(segment.data, '1f43b675');

        const firstBlock = findAll(clusters[0].data, 'a3')[0].data;
        assert.equal(firstBlock[0], 0x81);                                  // track 1
        assert.equal(new DataView(firstBlock.buffer, firstBlock.byteOffset).getInt16(1), 0);
        assert.equal(firstBlock[3], 0x80);                                  // keyframe
        assert.deepEqual([...firstBlock.subarray(4)], [0, 0x55]);           // payload

        const secondBlock = findAll(clusters[0].data, 'a3')[1].data;
        assert.equal(new DataView(secondBlock.buffer, secondBlock.byteOffset).getInt16(1), 31);
        assert.equal(secondBlock[3], 0x00);                                 // delta
    });

    it('keeps every cluster-relative timestamp inside int16 range', () => {
        // 40 seconds of frames with a single leading keyframe: the writer must
        // still split, because SimpleBlock offsets are signed 16-bit.
        const chunks = fakeChunks(1280, FRAME_US, 100000);
        const webm = buildWebM({
            width: 64, height: 64, frameDurationUs: FRAME_US,
            durationMs: 1280 * FRAME_US / 1000, chunks,
        });
        const segment = childrenOf(webm).find(c => c.id === '18538067');
        for (const cluster of findAll(segment.data, '1f43b675')) {
            for (const block of findAll(cluster.data, 'a3')) {
                const rel = new DataView(block.data.buffer, block.data.byteOffset).getInt16(1);
                assert.ok(rel >= -32768 && rel <= 32767, `relative timestamp out of range: ${rel}`);
            }
        }
    });
});
