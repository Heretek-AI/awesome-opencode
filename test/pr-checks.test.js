const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePullRequest } = require('../scripts/utils/pr-checks');
const { normalizeInput, parseIssueForm } = require('../scripts/utils/submission');

const good = [
  'name: Thing',
  'repo: https://github.com/someone/brand-new-thing',
  'tagline: Does the thing',
  'description: Does the thing well.',
  'kind: plugin',
  'topics:',
  '  - workflow',
  'compat: v2',
  ''
].join('\n');
const existing = { category: 'plugins', id: 'old', file: 'data/plugins/old.yaml', data: { name: 'Old', repo: 'https://github.com/someone/old', tagline: 't', description: 'd', kind: 'plugin', topics: ['ui'], compat: 'v2' } };

test('a valid new entry is ready', async () => {
  const r = await analyzePullRequest({ changes: [{ path: 'data/plugins/thing.yaml', status: 'added', content: good }], baseEntries: [existing], probe: false });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.labels, ['ready']);
  assert.deepEqual(r.categories, ['plugins']);
});

test('editing the generated README is rejected', async () => {
  const r = await analyzePullRequest({ changes: [{ path: 'README.md', status: 'modified' }], baseEntries: [existing], probe: false });
  assert.match(r.errors[0].message, /generated/);
  assert.deepEqual(r.labels, ['needs-metadata']);
});

test('broken YAML and duplicates are reported against the PR file', async () => {
  const broken = await analyzePullRequest({ changes: [{ path: 'data/plugins/x.yaml', status: 'added', content: 'tagline: A: B\nname: x' }], baseEntries: [], probe: false });
  assert.match(broken.errors[0].message, /invalid YAML/);
  const dup = await analyzePullRequest({
    changes: [{ path: 'data/plugins/thing.yaml', status: 'added', content: good.replace('brand-new-thing', 'old') }],
    baseEntries: [existing],
    probe: false
  });
  assert.ok(dup.errors.some(e => /duplicate/.test(e.message)));
});

test('reusing a filename for another repo needs a human', async () => {
  const r = await analyzePullRequest({
    changes: [{ path: 'data/plugins/old.yaml', status: 'modified', content: good, baseContent: 'repo: https://github.com/someone/old\n' }],
    baseEntries: [existing],
    probe: false
  });
  assert.ok(r.warnings.some(w => /changes this entry's target/.test(w.message)));
  assert.ok(r.labels.includes('needs-human'));
});

test('issue form parsing and normalization', () => {
  const body = '### Name\n\nThing\n\n### Repository URL\n\nhttps://github.com/a/b/tree/main/packages/x\n\n### npm package\n\n_No response_\n\n### Category\n\nplugins\n\n### Topics\n\nmemory, context\n\n### Installation\n\n```markdown\nnpm i thing\n```';
  const fields = parseIssueForm(body);
  assert.equal(fields.name, 'Thing');
  assert.equal(fields.npm, undefined);
  assert.equal(fields.installation, 'npm i thing');
  const { category, data } = normalizeInput(fields);
  assert.equal(category, 'plugins');
  assert.equal(data.repo, 'https://github.com/a/b');
  assert.equal(data.path, 'packages/x');
  assert.deepEqual(data.topics, ['memory', 'context']);
});
