/**
 * Keyword-based suggestions for kind/topics, used when a bot writes an entry
 * (scout candidates, backfilling older PRs). Contributors pick topics themselves in the issue form.
 */

const TOPIC_RULES = {
  memory: /\bmemor|recall|remember|knowledge graph|journal|long-term/i,
  context: /\bcontext\b|compact|compaction|prun|fewer tokens|token (use|usage|sav|reduc)|prompt.?cache|compress/i,
  orchestration: /multi-agent|subagent|sub-agent|orchestrat|agent team|parallel agent|background (agent|task)|swarm|delegat/i,
  workflow: /workflow|spec-driven|planning|planner|\bplan\b|ralph|\bgoal\b|methodolog|brainstorm/i,
  providers: /provider|\bauth\b|oauth|gateway|proxy|routing|router|model discovery|openai-compatible|litellm|subscription|api key/i,
  cost: /\bcost|quota|usage|billing|pricing|spend|rate.?limit/i,
  notifications: /notif|\bbell\b|alert|ntfy|toast/i,
  sessions: /session|history|handoff|transcript|resume/i,
  'code-quality': /code review|\breview\b|lint|\btest|verif|quality|refactor/i,
  security: /secur|sandbox|secret|\.env\b|pii|redact|privacy|injection|jailbreak|destructive|guardrail|leak/i,
  git: /\bgit\b|github|gitlab|pull request|worktree|commit/i,
  remote: /remote|mobile|telegram|discord|slack|whatsapp|phone|\bios\b|android/i,
  web: /browser|scrap|crawl|web search|search the web|playwright|puppeteer|chromium/i,
  ui: /\btui\b|sidebar|dashboard|status ?line|panel|\bgui\b|desktop app/i,
  voice: /voice|speech|\bstt\b|\btts\b|dictation|whisper/i,
  media: /image|video|pptx|slides|diagram|\bpdf\b|ocr/i,
  docs: /documentation|\bdocs\b|research|tutorial|knowledge base|wiki/i,
  environment: /docker|container|devcontainer|direnv|shell|tmux|zellij|\bnix\b|\bwsl\b/i,
  observability: /telemetry|tracing|observab|monitor|logging|analytics|metrics|opentelemetry/i,
  integrations: /jira|linear|notion|issue tracker|payment|stripe|calendar|email|figma|obsidian/i,
  'code-intel': /\blsp\b|tree-sitter|code search|semantic search|indexing|code ?map|symbol|language server/i,
  prompting: /prompt|persona|personality|system prompt|\bskills?\b|instructions/i
};

const DEFAULT_KIND = { plugins: 'plugin', themes: 'theme', agents: 'agent', projects: 'tool', resources: 'guide' };

/**
 * Suggest up to three topics from free text (name + tagline + description).
 * @param {string} text
 * @returns {string[]}
 */
function suggestTopics(text) {
  const topics = Object.entries(TOPIC_RULES).filter(([, re]) => re.test(text)).map(([topic]) => topic);
  return topics.length ? topics.slice(0, 3) : ['workflow'];
}

/**
 * Suggest a kind for a category, refined by text for projects/resources.
 * @param {string} category
 * @param {string} text
 * @returns {string}
 */
function suggestKind(category, text) {
  const t = text.toLowerCase();
  if (category === 'agents') return /\bskills?\b/.test(t) && !/subagent/.test(t) ? 'skill' : 'agent';
  if (category === 'projects' || category === 'resources') {
    if (/\bmcp\b|model context protocol/.test(t) && /server/.test(t)) return 'mcp-server';
    if (category === 'projects' && /desktop|\bgui\b|web ui|mobile|\bios\b|android|vs ?code|neovim|telegram|discord|slack|\bapp\b|client/.test(t)) return 'client';
    if (category === 'resources' && /config|starter|template|dotfiles/.test(t)) return 'config';
  }
  return DEFAULT_KIND[category] || 'tool';
}

module.exports = { suggestKind, suggestTopics };
