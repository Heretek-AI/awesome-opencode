const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { canonicalKey, checkCatalog, checkEntry, loadCatalog } = require('../scripts/utils/catalog');
const { dumpEntry } = require('../scripts/utils/format');
const { escapeHtml, generateEntryHtml } = require('../scripts/utils/template');

const base = {
  name: 'Thing',
  repo: 'https://github.com/someone/thing',
  tagline: 'Does the thing',
  description: 'Does the thing well.',
  kind: 'plugin',
  topics: ['workflow'],
  compat: 'v2'
};
const entry = (data, category = 'plugins', file = 'data/plugins/thing.yaml') => ({ category, id: 'thing', file, data: { ...base, ...data } });

test('the committed catalog is valid', () => {
  const { entries, errors } = loadCatalog();
  assert.deepEqual(errors, []);
  assert.deepEqual(checkCatalog(entries), []);
  assert.ok(entries.length > 400);
});

test('repo must be a repository root', () => {
  for (const repo of [
    'https://github.com/a/b/tree/main/packages/x',
    'https://github.com/a/b/blob/main/x.ts',
    'https://www.npmjs.com/package/x',
    'https://example.com'
  ]) {
    assert.match(checkEntry(entry({ repo })).join(), /repository root/, repo);
  }
  for (const repo of ['https://github.com/a/b', 'https://codeberg.org/a/b', 'https://gist.github.com/a/0123abc', 'https://github.com/a/b/discussions/19']) {
    assert.deepEqual(checkEntry(entry({ repo })), [], repo);
  }
});

test('unknown fields, bad enums, placeholders and mojibake are rejected', () => {
  assert.match(checkEntry(entry({ install: 'x' })).join(), /unknown field "install"/);
  assert.match(checkEntry(entry({ topics: ['nope'] })).join(), /allowed values/);
  assert.match(checkEntry(entry({ repo: 'https://github.com/YOUR_USERNAME/thing' })).join(), /placeholder/);
  assert.match(checkEntry(entry({ tagline: 'Fast 鈥? really' })).join(), /mis-encoded/);
  assert.match(checkEntry(entry({ tagline: 'x'.repeat(121) })).join(), /120/);
});

test('kind must fit the category and plugins need compat', () => {
  assert.match(checkEntry(entry({ kind: 'client' })).join(), /does not belong in data\/plugins/);
  assert.match(checkEntry(entry({ compat: undefined })).join(), /must declare compat/);
  assert.deepEqual(checkEntry(entry({ kind: 'client', compat: undefined }, 'projects', 'data/projects/thing.yaml')), []);
});

test('duplicates are keyed on repo and path', () => {
  const a = entry({}, 'plugins', 'data/plugins/a.yaml');
  const b = entry({ repo: 'https://github.com/SomeOne/Thing.git' }, 'plugins', 'data/plugins/b.yaml');
  assert.match(checkCatalog([a, b]).map(p => p.message).join(), /duplicate of data\/plugins\/a.yaml/);
  const c = entry({ path: 'packages/other' }, 'plugins', 'data/plugins/c.yaml');
  assert.deepEqual(checkCatalog([a, c]), []);
  assert.equal(canonicalKey({ repo: 'https://github.com/A/B/', path: 'x/' }), 'github.com/a/b#x');
});

test('dumpEntry quotes values that would break YAML and round-trips', () => {
  const data = { ...base, tagline: 'Plain: no jargon', description: 'Line one\nLine two: with colon' };
  const text = dumpEntry(data);
  assert.deepEqual(yaml.load(text), data);
  assert.ok(text.indexOf('name:') < text.indexOf('repo:') && text.indexOf('kind:') < text.indexOf('compat:'));
});

test('README entries escape contributor text and show compat badges', () => {
  assert.equal(escapeHtml('<b>"x" & y</b>'), '&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
  const html = generateEntryHtml({ ...base, description: 'run opencode <prompt>', compat: 'v1', npm: 'thing', path: 'pkg/x' }, 'plugins');
  assert.match(html, /&lt;prompt&gt;/);
  assert.match(html, /<code>V1 only<\/code>/);
  assert.match(html, /tree\/HEAD\/pkg\/x/);
  assert.ok(html.includes('href="https://www.npmjs.com/package/thing"'));
  assert.doesNotMatch(generateEntryHtml({ ...base, compat: 'n/a' }, 'projects'), /<code>/);
});
