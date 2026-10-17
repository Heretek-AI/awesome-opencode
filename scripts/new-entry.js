#!/usr/bin/env node
/**
 * Scaffold a catalog entry with valid formatting.
 *
 * Usage:
 *   npm run new -- --category plugins --repo https://github.com/me/opencode-thing \
 *     --tagline "Does the thing" --topics memory,context [--name "Thing"] [--description "..."] \
 *     [--npm opencode-thing] [--path packages/thing] [--kind plugin] [--homepage URL]
 *
 * Name and description default to the GitHub repo's name and description. The V2 check runs for
 * plugins and fills in `compat`. Writes data/<category>/<name>.yaml and prints any problems.
 */

const fs = require('fs');
const path = require('path');
const { CATEGORIES, KINDS, TOPICS, parseRepoUrl } = require('./utils/catalog');
const { getRepos } = require('./utils/github');
const { buildEntry } = require('./utils/submission');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      args[key] = next && !next.startsWith('--') ? (i++, next) : true;
    }
  }
  return args;
}

function usage(message) {
  console.error(`${message}\n
Required: --category <${CATEGORIES.join('|')}> --repo <url> --tagline <text> --topics <list>
Optional: --name --description --npm --path --kind <${KINDS.join('|')}> --homepage --installation --force
Topics (1-3, comma-separated): ${TOPICS.join(', ')}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.category || !args.repo || !args.tagline || !args.topics) usage('Missing required options.');

  const parsed = parseRepoUrl(args.repo);
  if ((!args.name || !args.description) && parsed && parsed.host === 'github.com') {
    const info = (await getRepos([{ owner: parsed.owner, name: parsed.name }])).get(`${parsed.owner}/${parsed.name}`);
    if (info) {
      args.name = args.name || parsed.name;
      args.description = args.description || info.description || undefined;
    }
  }

  const result = await buildEntry(args);
  for (const note of result.notes) console.log(`ℹ ${note}`);
  if (!result.file) usage(result.problems.join('\n'));

  const target = path.join(ROOT, result.file);
  if (!result.ok && !args.force) {
    console.error(`✗ Not written:\n${result.problems.map(p => `  - ${p}`).join('\n')}\n(pass --force to write it anyway and fix by hand)`);
    process.exit(1);
  }
  fs.writeFileSync(target, result.text);
  console.log(`✓ Wrote ${result.file}${result.ok ? '' : ' (with problems; run npm run validate)'}`);
  console.log(result.text);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
