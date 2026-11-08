import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SourceTextModule } from 'node:vm';

const module = new SourceTextModule(readFileSync(new URL('../modules/text-normalization.js', import.meta.url), 'utf8'));
await module.link(() => { throw new Error('Unexpected import'); });
await module.evaluate();
const { normalizeVneText } = module.namespace;

test('each supported space substitute becomes exactly one ordinary space', () => {
    const codes = [0xA0, 0x1680, ...Array.from({ length: 12 }, (_, i) => 0x2000 + i),
        0x202F, 0x205F, 0x2800, 0x3000, 0xFEFF, 0x115F, 0x1160, 0x3164, 0xFFA0];
    for (const code of codes) {
        assert.equal(normalizeVneText(`a${String.fromCodePoint(code)}b`), 'a b', code.toString(16));
    }
    assert.equal(normalizeVneText('a\u2800\u2800b'), 'a  b');
});

test('normal text, layout and meaningful Unicode stay intact', () => {
    const text = 'Русский  text\r\n\t👩‍💻 ❤️ فارسی\u200Ctext\u2060x\u180E';
    assert.equal(normalizeVneText(text), text);
    assert.equal(normalizeVneText(normalizeVneText('a\u2800b')), 'a b');
});
