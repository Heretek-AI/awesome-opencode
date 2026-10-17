/**
 * Template rendering utilities for awesome-opencode
 */

const fs = require('fs');
const path = require('path');

const COMPAT_BADGES = {
  v2: '<code>V2</code>',
  v1: '<code>V1 only</code>',
  unknown: '<code>unverified</code>'
};

/**
 * Read the README template
 * @returns {string} Template content
 */
function readTemplate() {
  const templatePath = path.join(__dirname, '../../templates/README.template.md');
  return fs.readFileSync(templatePath, 'utf8');
}

/**
 * Replace a placeholder in the template
 * @param {string} template - Template content
 * @param {string} placeholder - Placeholder name (without braces)
 * @param {string} content - Content to insert
 * @returns {string} Updated template
 */
function replacePlaceholder(template, placeholder, content) {
  const pattern = new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g');
  return template.replace(pattern, () => content);
}

/**
 * Escape text for use inside HTML (entries are untrusted contributor text).
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape text for a markdown table cell.
 * @param {string} text
 * @returns {string}
 */
function escapeCell(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Parse a URL, or null when it is not one.
 * @param {string} url
 * @returns {URL|null}
 */
function parseUrl(url) {
  try { return new URL(url); } catch { return null; }
}

/**
 * True for npm package pages (they duplicate the npm link, so they are not shown as docs).
 * @param {string} url
 * @returns {boolean}
 */
function isNpmPage(url) {
  const u = parseUrl(url);
  return Boolean(u && (u.hostname === 'www.npmjs.com' || u.hostname === 'npmjs.com') && u.pathname.startsWith('/package/'));
}

/**
 * URL of the entry's code, including the monorepo subfolder when set.
 * @param {object} entry - Parsed YAML data
 * @returns {string}
 */
function sourceUrl(entry) {
  return entry.path ? `${entry.repo.replace(/\/+$/, '')}/tree/HEAD/${entry.path}` : entry.repo;
}

/**
 * Generate HTML for a single entry
 * @param {object} entry - Parsed YAML data
 * @param {string} category - Category directory name
 * @returns {string} HTML string for the details element
 */
function generateEntryHtml(entry, category) {
  const url = parseUrl(entry.repo);
  const isGist = Boolean(url && url.hostname === 'gist.github.com');
  const isDiscussion = Boolean(url && url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/discussions\//.test(url.pathname));

  // Determine link text based on URL type first
  let linkText = '🔗 <b>View Repository</b>';
  if (isGist) {
    linkText = '🔗 <b>View Gist</b>';
  } else if (isDiscussion) {
    linkText = '🔗 <b>View Discussion</b>';
  }

  // Extract owner/repo from URL for star badge (only for non-gist, non-discussion GitHub repos)
  const repoMatch = url && url.hostname === 'github.com' ? url.pathname.match(/^\/([^/]+)\/([^/]+)/) : null;

  let summaryContent = `<b>${escapeHtml(entry.name)}</b>`;

  // Add star badge if it's a GitHub repo (not a gist or discussion)
  if (repoMatch && !isGist && !isDiscussion) {
    const owner = repoMatch[1];
    const repo = repoMatch[2].replace(/\.git$/, '').replace(/\/$/, '');
    const starBadge = `https://badgen.net/github/stars/${owner}/${repo}`;
    summaryContent += ` <img src="${starBadge}" height="14"/>`;
  }

  // Compatibility badge: always for plugins, otherwise only when the entry uses the OpenCode API
  const compat = entry.compat || (category === 'plugins' ? 'unknown' : 'n/a');
  if (COMPAT_BADGES[compat] && (category === 'plugins' || compat !== 'unknown')) {
    summaryContent += ` ${COMPAT_BADGES[compat]}`;
  }
  if (entry.also && entry.also.includes('mcp-server')) {
    summaryContent += ' <code>MCP</code>';
  }

  summaryContent += ` - <i>${escapeHtml(entry.tagline)}</i>`;

  const links = [`<a href="${escapeHtml(sourceUrl(entry))}">${linkText}</a>`];
  if (entry.npm) {
    links.push(`<a href="https://www.npmjs.com/package/${escapeHtml(entry.npm)}">📦 <b>npm</b></a>`);
  }
  if (entry.homepage && !isNpmPage(entry.homepage)) {
    links.push(`<a href="${escapeHtml(entry.homepage)}">📖 <b>Docs</b></a>`);
  }

  return `<details>
  <summary>${summaryContent}</summary>
  <blockquote>
    ${escapeHtml(entry.description)}
    <br><br>
    ${links.join(' &nbsp;•&nbsp; ')}
  </blockquote>
</details>`;
}

/**
 * Write the final README
 * @param {string} content - Generated README content
 */
function writeReadme(content) {
  const readmePath = path.join(__dirname, '../../README.md');
  fs.writeFileSync(readmePath, content, 'utf8');
}

module.exports = {
  escapeCell,
  escapeHtml,
  isNpmPage,
  readTemplate,
  replacePlaceholder,
  generateEntryHtml,
  sourceUrl,
  writeReadme
};
