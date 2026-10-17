const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { manifestMarkers, sourceMarkers, tarFiles, verdict } = require('../scripts/utils/compat');

const detect = manifest => verdict([{ source: 'package.json', ...manifestMarkers(manifest) }]).compat;

test('V2 markers', () => {
  assert.equal(detect({ dependencies: { '@opencode/plugin': '^2.0.0' } }), 'v2');
  assert.equal(detect({ peerDependencies: { '@opencode/theme': '2.0.14' } }), 'v2');
  assert.equal(detect({ devDependencies: { 'plugin-v2': 'npm:@opencode/plugin@2.0.14', '@opencode-ai/plugin': '1.18.25' } }), 'v2');
  assert.equal(detect({ dependencies: { '@opencode-ai/plugin': '0.0.0-beta-18027' } }), 'v2');
  assert.equal(detect({ dependencies: { '@opencode-ai/plugin': 'next' } }), 'v2');
  assert.equal(detect({ dependencies: { '@opencode-ai/client': '0.0.0-next-17444' } }), 'v2');
});

test('V1 markers', () => {
  assert.equal(detect({ dependencies: { '@opencode-ai/plugin': '^1.18.0' } }), 'v1');
  assert.equal(detect({ dependencies: { '@opencode-ai/plugin': '*' } }), 'v1');
  assert.equal(detect({ dependencies: { '@opencode-ai/sdk': '>=1.0.0' } }), 'v1');
});

test('no markers is unknown', () => {
  assert.equal(detect({ dependencies: { zod: '^3' } }), 'unknown');
  assert.equal(verdict([]).compat, 'unknown');
});

test('source markers', () => {
  const v2 = sourceMarkers('import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({ id: "x", async setup(ctx) {} })');
  assert.deepEqual(v2.v2, ['@opencode/plugin']);
  assert.equal(v2.define, true);
  assert.equal(sourceMarkers('export const P = async ({ project, client, $, directory }) => ({})').v1Signature, true);
  assert.equal(sourceMarkers('export const X = async () => ({\n "chat.params": async ({ model }, out) => {} })').v1Signature, true);
  assert.equal(sourceMarkers('export const MAX = 1;').v1Signature, false);
  assert.equal(sourceMarkers('const plugin = { id: PLAIN_ID, server: PlainPlugin, setup: setupPlain };').v2Signature, true);
  assert.equal(sourceMarkers('export default { id: "x", async setup(ctx) { ctx.session.hook("prompt") } }').v2Signature, true);
  assert.equal(sourceMarkers('export default { id: "obvious-grid", server: async (input) => ({ event }) }').v2Signature, false);
});

test('tarFiles reads regular files and strips the top folder', () => {
  const header = (name, size, type = '0') => {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write(type, 156);
    return h;
  };
  const body = Buffer.from('export default 1');
  const padded = Buffer.concat([body, Buffer.alloc(512 - body.length)]);
  const tar = Buffer.concat([header('owner-repo-sha/', 0, '5'), header('owner-repo-sha/src/index.ts', body.length), padded, Buffer.alloc(1024)]);
  const files = [...tarFiles(zlib.gunzipSync(zlib.gzipSync(tar)))];
  assert.deepEqual(files.map(f => f.name), ['src/index.ts']);
  assert.equal(files[0].data.toString(), 'export default 1');
});
