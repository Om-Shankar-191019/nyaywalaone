import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeSource, sha256Hex, sourceHash } from '../../src/lib/hash.js';

describe('normalizeSource', () => {
  it('converts CRLF and lone CR to LF', () => {
    assert.equal(normalizeSource('int main(){\r\nreturn 0;\r\n}\r\n'), 'int main(){\nreturn 0;\n}\n');
    assert.equal(normalizeSource('a\rb\n'), 'a\nb\n');
  });

  it('keeps exactly one trailing newline', () => {
    assert.equal(normalizeSource('int x;'), 'int x;\n');
    assert.equal(normalizeSource('int x;\n\n\n'), 'int x;\n');
  });

  it('does not trim inside a string literal', () => {
    assert.equal(normalizeSource('printf("a  b");\n'), 'printf("a  b");\n');
  });

  it('normalises the same program to the same hash across line endings', () => {
    const unix = '#include <stdio.h>\nint main(void){return 0;}\n';
    const windows = '#include <stdio.h>\r\nint main(void){return 0;}\r\n';
    assert.equal(sourceHash(unix), sourceHash(windows));
  });

  it('changes the hash when the program changes', () => {
    assert.notEqual(sourceHash('int main(void){return 0;}'), sourceHash('int main(void){return 1;}'));
  });
});

describe('sha256Hex', () => {
  it('matches the known digest of the empty string', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
