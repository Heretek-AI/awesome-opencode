/**
 * Canonical YAML formatting for catalog entries.
 *
 * All bot-written and scaffolded entries go through dumpEntry() so quoting is always valid YAML
 * (unquoted ": " in a tagline broke README generation for every entry before this existed).
 */

const yaml = require('js-yaml');

const KEY_ORDER = [
  'name', 'repo', 'path', 'npm', 'homepage', 'tagline', 'description',
  'kind', 'also', 'topics', 'compat', 'scope', 'tags', 'min_version', 'installation'
];

/**
 * Order keys canonically; unknown keys are kept at the end so validation can report them.
 * @param {object} data
 * @returns {object}
 */
function orderEntry(data) {
  const ordered = {};
  for (const key of KEY_ORDER) {
    if (data[key] !== undefined && data[key] !== null && !(Array.isArray(data[key]) && data[key].length === 0)) {
      ordered[key] = data[key];
    }
  }
  for (const key of Object.keys(data)) {
    if (!(key in ordered) && !KEY_ORDER.includes(key) && !key.startsWith('_')) ordered[key] = data[key];
  }
  return ordered;
}

/**
 * Serialize an entry to YAML text.
 * @param {object} data
 * @returns {string}
 */
function dumpEntry(data) {
  const clean = orderEntry(data);
  for (const key of ['name', 'tagline', 'description']) {
    if (typeof clean[key] === 'string') clean[key] = clean[key].trim();
  }
  return yaml.dump(clean, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

module.exports = { KEY_ORDER, dumpEntry, orderEntry };
