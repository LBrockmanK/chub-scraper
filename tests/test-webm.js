import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { vint, uint, float64, concatBytes, element } from '../webm.js';

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
