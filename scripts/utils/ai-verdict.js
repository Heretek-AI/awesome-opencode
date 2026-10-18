/**
 * AI review verdicts: parse `opencode run --format json` output, validate it strictly, and render it.
 *
 * The model's reply is untrusted (it read third-party text), so nothing it says is acted on until it
 * passes validateVerdict(), and every string is escaped before it reaches a comment.
 */

const Ajv = require('ajv');
const yaml = require('js-yaml');
const { CATEGORIES, KINDS, TOPICS, checkEntry } = require('./catalog');
const { escapeHtml } = require('./template');

const MARKER = '<!-- ai-review -->';
const AI_LABELS = { approve: 'ai-approve', fix: 'ai-fix', close: 'ai-close', unsure: 'ai-unsure' };
const ACCEPT_CONFIDENCE = 70;

const policy = {
  type: 'object',
  additionalProperties: false,
  required: ['opencode_relevant', 'crypto', 'duplicate_of'],
  properties: {
    opencode_relevant: { type: 'boolean' },
    crypto: { type: 'boolean' },
    duplicate_of: { type: ['string', 'null'], maxLength: 200 }
  }
};
const common = {
  kind: { anyOf: [{ enum: KINDS }, { type: 'null' }] },
  topics: { type: 'array', maxItems: 3, uniqueItems: true, items: { enum: TOPICS } },
  reasons: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 300 } },
  policy,
  confidence: { type: 'integer', minimum: 0, maximum: 100 }
};
const SCHEMAS = {
  pr: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'number', 'head_sha', 'verdict', 'category', 'kind', 'topics', 'reasons', 'policy', 'suggested_yaml', 'confidence'],
    properties: {
      type: { const: 'pr' },
      number: { type: 'integer' },
      head_sha: { type: 'string', pattern: '^[0-9a-f]{7,40}$' },
      verdict: { enum: Object.keys(AI_LABELS) },
      category: { anyOf: [{ enum: CATEGORIES }, { type: 'null' }] },
      suggested_yaml: { type: ['string', 'null'], maxLength: 4000 },
      ...common
    }
  },
  scout: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'id', 'package', 'verdict', 'kind', 'topics', 'tagline', 'reasons', 'policy', 'confidence'],
    properties: {
      type: { const: 'scout' },
      id: { type: 'string', pattern: '^c\\d+$' },
      package: { type: 'string', maxLength: 214 },
      verdict: { enum: ['accept', 'decline', 'unsure'] },
      tagline: { type: ['string', 'null'], minLength: 1, maxLength: 120 },
      ...common
    }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = Object.fromEntries(Object.entries(SCHEMAS).map(([type, schema]) => [type, ajv.compile(schema)]));

/** Last JSON object in a block of text: a fenced ```json block, else the last balanced {...}. */
function lastJsonObject(text) {
  const fenced = [...String(text).matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  for (const block of fenced.reverse()) {
    try { return JSON.parse(block); } catch { /* try the next one */ }
  }
  const s = String(text);
  for (let end = s.lastIndexOf('}'); end >= 0; end = s.lastIndexOf('}', end - 1)) {
    let depth = 0;
    let inString = false;
    for (let i = end; i >= 0; i--) {
      const ch = s[i];
      if (ch === '"' && s[i - 1] !== '\\') inString = !inString;
      if (inString) continue;
      if (ch === '}') depth++;
      else if (ch === '{' && --depth === 0) {
        try { return JSON.parse(s.slice(i, end + 1)); } catch { break; }
      }
    }
  }
  return null;
}

/**
 * Pull the verdict out of `opencode run --format json` output (JSON Lines events; the reply is in
 * `text` events at part.text). Falls back to treating the whole output as plain text.
 * @returns {{verdict: object|null, text: string, tools: {tool: string, status: string, input: object, error?: string}[], errors: string[]}}
 */
function extractVerdict(stdout) {
  const MAX = 400 * 1024; // the verdict is at the end; bound the work on runaway output
  stdout = String(stdout).slice(-MAX);
  const texts = [];
  const tools = [];
  const errors = [];
  let events = 0;
  for (const line of String(stdout).split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    // OpenCode events carry a session and a part; a bare verdict object (also with a `type`) is not one
    if (!event || typeof event.type !== 'string' || !(event.part || event.sessionID)) continue;
    events++;
    if (event.type === 'text' && event.part && typeof event.part.text === 'string') texts.push(event.part.text);
    if (event.type === 'error' && event.error) errors.push(`${event.error.type || 'error'}: ${event.error.message || ''}`.slice(0, 300));
    if (event.type === 'tool_use' && event.part) {
      const state = event.part.state || {};
      tools.push({ tool: event.part.tool, status: state.status, input: state.input || {}, error: state.error });
    }
  }
  const text = events ? texts.join('\n') : String(stdout);
  // The reply should be the final text part; search it first, then everything
  const verdict = (texts.length && lastJsonObject(texts[texts.length - 1])) || lastJsonObject(text);
  return { verdict, text, tools, errors };
}

/**
 * Validate a verdict against the schema and the item it is supposed to describe.
 * @param {object} verdict
 * @param {{type: 'pr'|'scout', number?: number, head_sha?: string, id?: string}} item
 * @returns {string[]} problems; empty when the verdict can be acted on
 */
function validateVerdict(verdict, item) {
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return ['reply contained no JSON object'];
  const validate = validators[item.type];
  if (!validate) return [`unknown item type ${item.type}`];
  const problems = validate(verdict) ? [] : validate.errors.map(e => `${e.instancePath || '/'} ${e.message}`);
  if (item.type === 'pr') {
    if (verdict.number !== item.number) problems.push(`number ${verdict.number} does not match PR #${item.number}`);
    if (typeof verdict.head_sha === 'string' && !item.head_sha.startsWith(verdict.head_sha)) problems.push('head_sha does not match the reviewed commit');
    if (verdict.verdict === 'fix' && !verdict.suggested_yaml) problems.push('verdict fix needs suggested_yaml');
  } else {
    if (verdict.id !== item.id) problems.push(`id ${verdict.id} does not match candidate ${item.id}`);
    if (verdict.verdict === 'accept' && !verdict.tagline) problems.push('verdict accept needs a tagline');
  }
  return problems;
}

/** Neutralize text for a GitHub comment: escape HTML and break @mentions and #references. */
function safe(text) {
  return escapeHtml(String(text).replace(/[\r\n]+/g, ' '))
    .replace(/@(?=[A-Za-z0-9])/g, '@​')
    .replace(/#(?=\d)/g, '#​');
}

/**
 * Check a suggested YAML entry with the catalog's own rules.
 * @returns {{ok: boolean, problems: string[], text: string}}
 */
function checkSuggestedYaml(text, category) {
  let data;
  try {
    data = yaml.load(text);
  } catch (err) {
    return { ok: false, problems: [`invalid YAML: ${err.reason || err.message}`], text };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, problems: ['not a YAML mapping'], text };
  const problems = category ? checkEntry({ category, id: 'suggested', file: `data/${category}/suggested.yaml`, data }) : ['no category given'];
  return { ok: problems.length === 0, problems, text };
}

/**
 * Comment body for a PR verdict, rendered by us from validated fields (never the model's prose as-is).
 * upsertComment() prepends MARKER; the sha comment records which commit was reviewed.
 */
function renderComment(verdict, item, { model } = {}) {
  const head = {
    approve: '✅ **Recommend merging**',
    fix: '🛠️ **Recommend merging after the changes below**',
    close: '🚫 **Recommend closing**',
    unsure: '❔ **Needs a maintainer**: the AI review could not decide'
  }[verdict.verdict];
  const lines = [
    `<!-- sha=${item.head_sha} -->`,
    `### AI review: ${head}`,
    '',
    ...verdict.reasons.map(r => `- ${safe(r)}`),
    ''
  ];
  const fields = [];
  if (verdict.category) fields.push(`category \`${verdict.category}\``);
  if (verdict.kind) fields.push(`kind \`${verdict.kind}\``);
  if (verdict.topics.length) fields.push(`topics ${verdict.topics.map(t => `\`${t}\``).join(', ')}`);
  if (fields.length) lines.push(`**Suggested placement:** ${fields.join(' · ')}`, '');
  const flags = [];
  if (!verdict.policy.opencode_relevant) flags.push('not clearly OpenCode-related');
  if (verdict.policy.crypto) flags.push('crypto/token/trading project (zero tolerance)');
  if (verdict.policy.duplicate_of) flags.push(`possible duplicate of \`${safe(verdict.policy.duplicate_of).replace(/`/g, '')}\``);
  if (flags.length) lines.push(`**Policy flags:** ${flags.join('; ')}`, '');
  if (verdict.suggested_yaml) {
    const check = checkSuggestedYaml(verdict.suggested_yaml, verdict.category);
    lines.push(
      '<details><summary>Suggested entry' + (check.ok ? ' (passes the catalog schema)' : ` (does not validate: ${safe(check.problems.join('; ')).slice(0, 300)})`) + '</summary>',
      '',
      '```yaml',
      verdict.suggested_yaml.replace(/```/g, "'''").trim(),
      '```',
      '</details>',
      ''
    );
  }
  lines.push(`<sub>Confidence ${verdict.confidence}/100 · reviewed commit \`${item.head_sha.slice(0, 7)}\`${model ? ` · ${safe(model)}` : ''} · advisory only: a maintainer decides. [How this works](https://github.com/Heretek-AI/awesome-opencode/blob/main/docs/policy.md#ai-review)</sub>`);
  return lines.join('\n');
}

/** Short note appended to a scout candidate line. */
function scoutNote(verdict) {
  // safe() escapes < and >, so the note cannot open or close the line's <!-- scout:… --> marker
  const reason = safe(verdict.reasons[0]).slice(0, 160);
  return ` — AI: ${verdict.verdict} (${reason})`;
}

/** True when a scout verdict is confident and clean enough to open a PR automatically. */
function shouldAccept(verdict) {
  return verdict.verdict === 'accept' && verdict.confidence >= ACCEPT_CONFIDENCE &&
    verdict.policy.opencode_relevant && !verdict.policy.crypto && !verdict.policy.duplicate_of;
}

/** Head SHA recorded in an existing AI review comment, if any. */
function reviewedSha(comments) {
  const found = [...comments].reverse().find(c => (c.body || '').startsWith(MARKER));
  const match = found && /<!-- sha=([0-9a-f]{7,40}) -->/.exec(found.body);
  return match ? match[1] : null;
}

module.exports = {
  ACCEPT_CONFIDENCE, AI_LABELS, MARKER,
  checkSuggestedYaml, extractVerdict, lastJsonObject, renderComment, reviewedSha, safe, scoutNote, shouldAccept, validateVerdict
};
