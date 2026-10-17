const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_SUNSET } = require('../scripts/utils/catalog');
const { migratedPlugins, removalCandidates, sunsetIssueBody } = require('../scripts/health-check');

const plugin = (id, compat) => ({
  category: 'plugins',
  id,
  file: `data/plugins/${id}.yaml`,
  data: { name: id, repo: `https://github.com/someone/${id}`, tagline: 't', description: 'd', kind: 'plugin', topics: ['workflow'], compat }
});
const recheck = results => new Map(Object.entries(results).map(([id, compat]) => [`data/plugins/${id}.yaml`, { compat, evidence: [`probe: ${compat}`] }]));

test('after the sunset, only V1 plugins the re-check still detects as V1 are removed', () => {
  const entries = ['still-v1', 'migrated', 'inconclusive', 'unprobed'].map(id => plugin(id, 'v1'));
  const compat = recheck({ 'still-v1': 'v1', migrated: 'v2', inconclusive: 'unknown' });
  const removed = removalCandidates(entries, {}, compat, V1_SUNSET).map(r => r.entry.id);
  assert.deepEqual(removed, ['still-v1']);
  assert.deepEqual(removalCandidates(entries, {}, compat, '2026-12-31'), []);
});

test('dead entries are removed after the grace period regardless of compat', () => {
  const entries = [plugin('gone', 'v2')];
  const removed = removalCandidates(entries, { 'data/plugins/gone.yaml': { since: '2020-01-01', reason: 'archived' } }, new Map());
  assert.equal(removed.length, 1);
});

test('plugins not marked v2 that now probe as V2 are migrations', () => {
  const entries = [plugin('a', 'v1'), plugin('b', 'unknown'), plugin('c', 'v1'), plugin('d', 'v2')];
  const compat = recheck({ a: 'v2', b: 'v2', c: 'unknown' });
  assert.deepEqual(migratedPlugins(entries, compat).map(e => e.id), ['a', 'b']);
});

test('the sunset issue lists remaining V1 plugins and pending migrations separately', () => {
  const entries = [plugin('stuck', 'v1'), plugin('moved', 'v1'), plugin('odd', 'unknown')];
  const body = sunsetIssueBody(entries, [entries[1]]);
  assert.match(body, /V1-only plugins \(1\)[\s\S]*stuck\.yaml/);
  assert.match(body, /catalog update pending \(1\)[\s\S]*moved\.yaml/);
  assert.match(body, /Could not be verified automatically \(1\)[\s\S]*odd\.yaml/);
  assert.doesNotMatch(body.split('catalog update pending')[0], /moved\.yaml/);
});
