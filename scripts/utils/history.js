/**
 * Git history helpers. Requires a full clone (actions/checkout with fetch-depth: 0);
 * in a shallow clone every file looks like it was added in the oldest fetched commit.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

/**
 * Date each data file was first added, newest commits first.
 * @returns {Map<string, string>} "data/plugins/x.yaml" -> ISO date; empty when git is unavailable
 */
function addedDates() {
  const dates = new Map();
  let out = '';
  try {
    out = execFileSync('git', ['log', '--diff-filter=A', '--name-only', '--format=@%cI', '--', 'data/'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return dates;
  }
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('@')) current = line.slice(1);
    else if (line.endsWith('.yaml') && current && !dates.has(line)) dates.set(line, current);
  }
  return dates;
}

module.exports = { addedDates };
