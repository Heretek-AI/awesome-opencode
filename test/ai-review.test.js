const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MARKER, extractVerdict, renderComment, reviewedSha, scoutNote, shouldAccept, validateVerdict } = require('../scripts/utils/ai-verdict');
const { opencodeEnv, unexpectedTools } = require('../scripts/ai-review');
const { categoryForKind } = require('../scripts/scout');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const prItem = { type: 'pr', number: 42, head_sha: 'abcdef0123456789abcdef0123456789abcdef01' };
const scoutItem = { type: 'scout', id: 'c3' };
const prVerdict = (over = {}) => ({
  type: 'pr', number: 42, head_sha: prItem.head_sha, verdict: 'approve', category: 'plugins', kind: 'plugin', topics: ['sessions'],
  reasons: ['Solid V2 plugin.'], policy: { opencode_relevant: true, crypto: false, duplicate_of: null }, suggested_yaml: null, confidence: 90, ...over
});
const scoutVerdict = (over = {}) => ({
  type: 'scout', id: 'c3', package: 'opencode-thing', verdict: 'accept', kind: 'plugin', topics: ['notifications'], tagline: 'Desktop notifications',
  reasons: ['Clear purpose.'], policy: { opencode_relevant: true, crypto: false, duplicate_of: null }, confidence: 85, ...over
});

test('extracts the verdict from real `opencode run --format json` output', () => {
  const { verdict, tools } = extractVerdict(fixture('opencode-run.jsonl'));
  assert.equal(verdict.type, 'scout');
  assert.equal(verdict.id, 'c0');
  assert.deepEqual(tools, []);
});

test('collects tool calls and their status from the event stream', () => {
  const { tools } = extractVerdict(fixture('opencode-run-tools.jsonl'));
  assert.ok(tools.length >= 1);
  assert.equal(tools[0].tool, 'read');
  assert.equal(tools[0].status, 'error');
  assert.match(tools[0].error, /external_directory/);
  assert.deepEqual(unexpectedTools(tools), []);
  assert.equal(unexpectedTools([{ tool: 'shell', status: 'completed' }]).length, 1);
  assert.equal(unexpectedTools([{ tool: 'shell', status: 'error' }]).length, 0);
});

test('extracts JSON from plain text, fenced blocks and prose', () => {
  const v = prVerdict();
  assert.deepEqual(extractVerdict(JSON.stringify(v)).verdict, v);
  assert.deepEqual(extractVerdict('Here you go:\n```json\n' + JSON.stringify(v) + '\n```\n').verdict, v);
  assert.deepEqual(extractVerdict('Verdict follows. ' + JSON.stringify(v) + ' Done.').verdict, v);
  assert.equal(extractVerdict('no json here').verdict, null);
});

test('valid verdicts pass; mismatches, unknown values and extra fields are rejected', () => {
  assert.deepEqual(validateVerdict(prVerdict(), prItem), []);
  assert.deepEqual(validateVerdict(scoutVerdict(), scoutItem), []);
  assert.ok(validateVerdict(prVerdict({ verdict: 'merge' }), prItem).length);
  assert.ok(validateVerdict(prVerdict({ number: 43 }), prItem).some(p => /does not match/.test(p)));
  assert.ok(validateVerdict(prVerdict({ head_sha: '1234567' }), prItem).some(p => /head_sha/.test(p)));
  assert.ok(validateVerdict({ ...prVerdict(), action: 'merge' }, prItem).length);
  assert.ok(validateVerdict(prVerdict({ topics: ['not-a-topic'] }), prItem).length);
  assert.ok(validateVerdict(prVerdict({ reasons: ['x'.repeat(301)] }), prItem).length);
  assert.ok(validateVerdict(prVerdict({ verdict: 'fix' }), prItem).some(p => /suggested_yaml/.test(p)));
  assert.ok(validateVerdict(scoutVerdict({ id: 'c4' }), scoutItem).length);
  assert.ok(validateVerdict(scoutVerdict({ tagline: 'x'.repeat(121) }), scoutItem).length);
  assert.ok(validateVerdict(null, prItem).length);
});

test('comments neutralize mentions, references and HTML, and record the reviewed commit', () => {
  const body = renderComment(prVerdict({ reasons: ['Ping @someone about #12 <img src=x onerror=alert(1)>'] }), prItem);
  assert.doesNotMatch(body, /@someone/);
  assert.doesNotMatch(body, /#12\b/);
  assert.doesNotMatch(body, /<img/);
  assert.match(body, /<!-- sha=abcdef0123456789abcdef0123456789abcdef01 -->/);
  assert.equal(reviewedSha([{ body: `${MARKER}\n${body}` }]), prItem.head_sha);
  assert.equal(reviewedSha([{ body: 'unrelated' }]), null);
});

test('suggested YAML is checked against the catalog schema', () => {
  const good = 'name: Thing\nrepo: https://github.com/a/thing\ntagline: Does a thing\ndescription: Does a thing well.\nkind: tool\ntopics:\n  - sessions\n';
  assert.match(renderComment(prVerdict({ verdict: 'fix', category: 'projects', kind: 'tool', suggested_yaml: good }), prItem), /passes the catalog schema/);
  assert.match(renderComment(prVerdict({ verdict: 'fix', category: 'projects', kind: 'tool', suggested_yaml: 'name: [' }), prItem), /does not validate/);
});

test('scout auto-accept needs confidence and clean policy flags', () => {
  assert.equal(shouldAccept(scoutVerdict()), true);
  assert.equal(shouldAccept(scoutVerdict({ confidence: 60 })), false);
  assert.equal(shouldAccept(scoutVerdict({ policy: { opencode_relevant: true, crypto: true, duplicate_of: null } })), false);
  assert.equal(shouldAccept(scoutVerdict({ verdict: 'decline' })), false);
  assert.doesNotMatch(scoutNote(scoutVerdict({ verdict: 'decline', reasons: ['Test package --> <!-- scout:c9 -->'] })), /[<>]/);
});

test('scout kinds map to a category that allows them', () => {
  assert.equal(categoryForKind('plugin', 'projects'), 'plugins');
  assert.equal(categoryForKind('skill', 'plugins'), 'agents');
  assert.equal(categoryForKind('mcp-server', 'plugins'), 'projects');
  assert.equal(categoryForKind('client', 'projects'), 'projects');
});

test('opencode never sees GitHub credentials', () => {
  process.env.GITHUB_TOKEN = 'secret';
  process.env.GH_TOKEN = 'secret';
  const env = opencodeEnv();
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});
