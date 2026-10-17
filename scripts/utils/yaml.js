/**
 * Filename helpers for awesome-opencode entries.
 * (Catalog loading lives in ./catalog.js.)
 */

/**
 * Convert a name to a filename-safe slug
 * @param {string} name - Entry name
 * @returns {string} Slugified filename (without extension)
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { slugify };
