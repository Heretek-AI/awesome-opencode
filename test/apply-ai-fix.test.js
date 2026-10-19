const test = require('node:test');
const assert = require('node:assert/strict');
const { MARKER, renderComment } = require('../scripts/utils/ai-verdict');
const {
  applyAiFix,
  extractCategoryHint,
  extractReviewedSha,
  extractSuggestedYaml,
  findAiComment,
  isFresh,
  isTriggerComment,
  parseArgs,
  targetFile
} = require('../scripts/apply-ai-fix');

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const prItem = { type: 'pr', number: 42, head_sha: HEAD };
const GOOD_YAML = 'name: Thing\nrepo: https://github.com/a/thing\ntagline: Does a thing\ndescription: Does a thing well.\nkind: tool\ntopics:\n  - sessions\n';
const fixVerdict = (over = {}) => ({
  type: 'pr', number: 42, head_sha: HEAD, verdict: 'fix', category: 'projects', kind: 'tool',
  topics: ['sessions'], reasons: ['Standalone CLI, so it belongs in projects.'],
  policy: { opencode_relevant: true, crypto: false, duplicate_of: null },
  suggested_yaml: GOOD_YAML, confidence: 80, ...over
});
const aiBody = (yamlText = GOOD_YAML, sha = HEAD) =>
  `${MARKER}\n<!-- sha=${sha} -->\n### AI review: fix\n\n**Suggested placement:** category \`projects\` · kind \`tool\`\n\n` +
  `<details><summary>Suggested entry (passes the catalog schema)</summary>\n\n\`\`\`yaml\n${yamlText}\`\`\`\n</details>\n`;

test('renderComment fix with valid suggestion includes the apply hint', () => {
  const body = renderComment(fixVerdict(), prItem);
  assert.match(body, /passes the catalog schema/);
  assert.match(body, /\/apply-ai-fix/);
  assert.match(body, /comment `\/apply-ai-fix` on this PR \(maintainers only\)/);
});

test('renderComment omits the hint for approve and for invalid suggestions', () => {
  const approve = renderComment({ ...fixVerdict(), verdict: 'approve', suggested_yaml: null }, prItem);
  assert.doesNotMatch(approve, /\/apply-ai-fix/);
  const bad = renderComment(fixVerdict({ suggested_yaml: 'name: [' }), prItem);
  assert.match(bad, /does not validate/);
  assert.doesNotMatch(bad, /\/apply-ai-fix/);
});

test('isTriggerComment only fires on the exact command string', () => {
  assert.equal(isTriggerComment('/apply-ai-fix please'), true);
  assert.equal(isTriggerComment('comment body without the command'), false);
  assert.equal(isTriggerComment(null), false);
});

test('findAiComment picks the latest marker comment and ignores others', () => {
  assert.equal(findAiComment([{ body: 'unrelated' }]), null);
  assert.equal(findAiComment([]), null);
  const comments = [{ body: `${MARKER}\nold` }, { body: 'unrelated' }, { body: `${MARKER}\nnew` }];
  assert.equal(findAiComment(comments).body, `${MARKER}\nnew`);
});

test('extractors handle missing sha, yaml and category', () => {
  assert.equal(extractReviewedSha(aiBody()), HEAD);
  assert.equal(extractReviewedSha('no marker here'), null);
  assert.equal(extractSuggestedYaml(aiBody()).includes('name: Thing'), true);
  assert.equal(extractSuggestedYaml(`${MARKER}\nno yaml here`), null);
  assert.equal(extractCategoryHint(aiBody()), 'projects');
  assert.equal(extractCategoryHint('no hint'), null);
  assert.equal(isFresh(HEAD, HEAD), true);
  assert.equal(isFresh(HEAD.slice(0, 7), HEAD), true);
  assert.equal(isFresh('1234567', HEAD), false);
  assert.equal(isFresh(null, HEAD), false);
});

test('targetFile requires exactly one catalog file', () => {
  assert.deepEqual(targetFile([]), { file: null, error: 'No catalog file in this PR' });
  assert.deepEqual(targetFile(['README.md']), { file: null, error: 'No catalog file in this PR' });
  assert.deepEqual(targetFile(['data/plugins/a.yaml']), { file: 'data/plugins/a.yaml', error: null });
  assert.deepEqual(targetFile(['data/plugins/a.yaml', 'data/themes/b.yaml']), { file: null, error: 'Multiple files; apply manually' });
});

test('parseArgs reads the CLI flags', () => {
  assert.deepEqual(parseArgs(['--pr', '42', '--sender', 'octo', '--comment-id', '7']), { pr: 42, sender: 'octo', commentId: 7, dryRun: false });
  assert.equal(parseArgs(['--pr', '42', '--sender', 'octo', '--dry-run']).dryRun, true);
});

function stubDeps(over = {}) {
  const posted = [];
  const gitCalls = [];
  const written = {};
  return {
    posted,
    gitCalls,
    written,
    deps: {
      getPull: async () => ({
        status: 200,
        data: { number: 42, state: 'open', head: { sha: HEAD, ref: 'add-thing', repo: { full_name: 'Heretek-AI/awesome-opencode' } }, base: { sha: 'base' } }
      }),
      getPermission: async () => ({ status: 200, data: { permission: 'write' } }),
      listComments: async () => [{ body: aiBody() }],
      listPrFiles: async () => [{ path: 'data/projects/thing.yaml', status: 'added' }],
      postComment: async (number, body) => { posted.push({ number, body }); return {}; },
      fetchHead: async ref => { gitCalls.push(['fetch', ref]); },
      checkoutHead: async ref => { gitCalls.push(['checkout', ref]); },
      writeFile: (abs, content) => { written[abs] = content; },
      stageAndCommit: async (file, message) => { gitCalls.push(['commit', file, message]); },
      pushHead: async ref => { gitCalls.push(['push', ref]); },
      runValidate: async () => {},
      ...over
    }
  };
}

test('applyAiFix rejects senders without write access', async () => {
  const { posted, gitCalls, deps } = stubDeps({ getPermission: async () => ({ status: 200, data: { permission: 'read' } }) });
  assert.equal(await applyAiFix({ pr: 42, sender: 'outsider' }, deps), 0);
  assert.match(posted[0].body, /Only maintainers with write access/);
  assert.deepEqual(gitCalls, []);
});

test('applyAiFix rejects unknown senders (permission 404)', async () => {
  const { posted, deps } = stubDeps({ getPermission: async () => ({ status: 404, data: { message: 'Not Found' } }) });
  assert.equal(await applyAiFix({ pr: 42, sender: 'ghost' }, deps), 0);
  assert.match(posted[0].body, /Only maintainers with write access/);
});

test('applyAiFix reports a missing AI comment', async () => {
  const { posted, deps } = stubDeps({ listComments: async () => [{ body: 'hello' }] });
  assert.equal(await applyAiFix({ pr: 42, sender: 'octo' }, deps), 0);
  assert.match(posted[0].body, /No AI review comment/);
});

test('applyAiFix rejects stale suggestions', async () => {
  const { posted, gitCalls, deps } = stubDeps({ listComments: async () => [{ body: aiBody(GOOD_YAML, '1234567890abcdef1234567890abcdef12345678') }] });
  assert.equal(await applyAiFix({ pr: 42, sender: 'octo' }, deps), 0);
  assert.match(posted[0].body, /stale/);
  assert.deepEqual(gitCalls, []);
});

test('applyAiFix rejects fork PRs without touching git', async () => {
  const { posted, gitCalls, deps } = stubDeps({
    getPull: async () => ({
      status: 200,
      data: { number: 42, state: 'open', head: { sha: HEAD, ref: 'add-thing', repo: { full_name: 'someone/awesome-opencode' } }, base: { sha: 'base' } }
    })
  });
  assert.equal(await applyAiFix({ pr: 42, sender: 'octo' }, deps), 0);
  assert.match(posted[0].body, /Fork PRs are not auto-updated/);
  assert.deepEqual(gitCalls, []);
});

test('applyAiFix rejects zero and multiple catalog files', async () => {
  const zero = stubDeps({ listPrFiles: async () => [{ path: 'README.md', status: 'modified' }] });
  assert.equal(await applyAiFix({ pr: 42, sender: 'octo' }, zero.deps), 0);
  assert.match(zero.posted[0].body, /No catalog file/);

  const multi = stubDeps({ listPrFiles: async () => [{ path: 'data/plugins/a.yaml' }, { path: 'data/themes/b.yaml' }] });
  assert.equal(await applyAiFix({ pr: 42, sender: 'octo' }, multi.deps), 0);
  assert.match(multi.posted[0].body, /Multiple files/);
});

test('applyAiFix rejects invalid suggestions without committing', async () => {
  const { posted, gitCalls, deps } = stubDeps({ listComments: async () => [{ body: aiBody('name: [') }] });
  assert.equal(await applyAiFix({ pr: 42, sender: 'octo' }, deps), 0);
  assert.match(posted[0].body, /does not validate/);
  assert.deepEqual(gitCalls, []);
});

test('applyAiFix does nothing on closed PRs', async () => {
  const { posted, deps } = stubDeps({
    getPull: async () => ({
      status: 200,
      data: { number: 42, state: 'closed', head: { sha: HEAD, ref: 'add-thing', repo: { full_name: 'Heretek-AI/awesome-opencode' } }, base: { sha: 'base' } }
    })
  });
  assert.equal(await applyAiFix({ pr: 42, sender: 'octo' }, deps), 0);
  assert.deepEqual(posted, []);
});

test('applyAiFix dry-run never touches git; full run commits and comments success', async () => {
  const dry = stubDeps();
  assert.equal(await applyAiFix({ pr: 42, sender: 'octo', dryRun: true }, dry.deps), 0);
  assert.deepEqual(dry.gitCalls, []);
  assert.deepEqual(dry.posted, []);

  const full = stubDeps();
  assert.equal(await applyAiFix({ pr: 42, sender: 'octo' }, full.deps), 0);
  assert.ok(full.gitCalls.length >= 4);
  assert.match(full.posted[0].body, /Applied the AI suggested entry/);
  const paths = Object.keys(full.written);
  assert.equal(paths.length, 1);
  assert.match(paths[0], /data.projects.thing\.yaml$/);
  assert.match(full.written[paths[0]], /name: Thing/);
});
