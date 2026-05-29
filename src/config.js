import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

const CONFIG_DIR = process.env.CODEX_CONFIG_DIR || join(homedir(), '.codex');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const TOKEN_CACHE_PATH = join(CONFIG_DIR, 'token-cache.json');

const MODEL_PRICING = {
  'gpt-4o': { input: 2.50, output: 10.00, cached: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.60, cached: 0.075 },
  'gpt-4.1': { input: 2.00, output: 8.00, cached: 0.50 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60, cached: 0.10 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40, cached: 0.025 },
  'gpt-4.5-preview': { input: 75.00, output: 150.00, cached: 37.50 },
  'gpt-5.5': { input: 3.00, output: 12.00, cached: 0.75 },
  'gpt-5.4': { input: 2.50, output: 10.00, cached: 0.625 },
  'gpt-5.4-mini': { input: 0.50, output: 2.00, cached: 0.125 },
  'big-pickle': { input: 0, output: 0, cached: 0 },
  'o3': { input: 10.00, output: 40.00, cached: 2.50 },
  'o4-mini': { input: 1.10, output: 4.40, cached: 0.275 },
};

export function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); }
  catch { return {}; }
}

export function saveConfig(config) {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function getApiKey() {
  const fromEnv = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
  if (fromEnv) return fromEnv;
  return loadConfig().apiKey || null;
}

export function setApiKey(key) {
  const config = loadConfig();
  config.apiKey = key;
  saveConfig(config);
}

export function getRawModel() {
  return process.env.CODEX_MODEL || loadConfig().model || 'opencode/big-pickle';
}

export function getModel() {
  const raw = getRawModel();
  const slashIdx = raw.indexOf('/');
  if (slashIdx > 0) return raw.substring(slashIdx + 1);
  return raw;
}

export function getModelPrefix() {
  const raw = getRawModel();
  const slashIdx = raw.indexOf('/');
  if (slashIdx > 0) return raw.substring(0, slashIdx).toLowerCase();
  return '';
}

export function getProvider() {
  const raw = getRawModel();
  const slashIdx = raw.indexOf('/');
  if (slashIdx > 0) {
    const prefix = raw.substring(0, slashIdx).toLowerCase();
    if (prefix === 'ollama') return 'ollama';
    if (prefix === 'opencode') return 'opencode';
    if (prefix === 'lmstudio') return 'lmstudio';
  }
  if (getApiKey()) return 'openai';
  if (isOllamaRunning()) return 'ollama';
  if (isLmStudioRunning()) return 'lmstudio';
  return 'opencode';
}

export function getBaseUrl() {
  if (process.env.CODEX_BASE_URL) return process.env.CODEX_BASE_URL;
  switch (getProvider()) {
    case 'ollama': return 'http://localhost:11434/v1';
    case 'lmstudio': return 'http://localhost:1234/v1';
    case 'opencode': return 'https://opencode.ai/zen/v1';
    default: return 'https://api.openai.com/v1';
  }
}

export function needsApiKey() {
  const p = getProvider();
  return p === 'openai';
}

const VISION_MODELS = ['gpt-4o', 'gpt-4.1', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'o3', 'o4-mini'];

export function supportsVision() {
  const model = getModel();
  return VISION_MODELS.includes(model) || loadConfig().vision === true;
}

let _ollamaCheck = null;
let _ollamaCheckTime = 0;

export function isOllamaRunning() {
  if (_ollamaCheck !== null && Date.now() - _ollamaCheckTime < 30000) return _ollamaCheck;
  try {
    execSync('curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 || wget -q http://localhost:11434/api/tags -O /dev/null 2>&1', { timeout: 2000 });
    _ollamaCheck = true;
  } catch { _ollamaCheck = false; }
  _ollamaCheckTime = Date.now();
  return _ollamaCheck;
}

export function resetOllamaCheck() {
  _ollamaCheck = null;
}

let _lmStudioCheck = null;
let _lmStudioCheckTime = 0;

export function isLmStudioRunning() {
  if (_lmStudioCheck !== null && Date.now() - _lmStudioCheckTime < 30000) return _lmStudioCheck;
  try {
    execSync('curl -sf http://localhost:1234/v1/models >/dev/null 2>&1 || wget -q http://localhost:1234/v1/models -O /dev/null 2>&1', { timeout: 2000 });
    _lmStudioCheck = true;
  } catch { _lmStudioCheck = false; }
  _lmStudioCheckTime = Date.now();
  return _lmStudioCheck;
}

export function resetLmStudioCheck() {
  _lmStudioCheck = null;
}

export function getDefaultOssModel() {
  if (isOllamaRunning()) return 'ollama/qwen2.5:0.5b';
  if (isLmStudioRunning()) return 'lmstudio/local-model';
  return 'opencode/big-pickle';
}

export function setModel(model) {
  const config = loadConfig();
  config.model = model;
  saveConfig(config);
}

export function getApprovalMode() {
  return process.env.CODEX_APPROVAL_MODE || loadConfig().approvalMode || 'auto';
}

export function setApprovalMode(mode) {
  const config = loadConfig();
  config.approvalMode = mode;
  saveConfig(config);
}

export function getPricing(model) {
  return MODEL_PRICING[model] || { input: 0, output: 0, cached: 0 };
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif', '.avif']);

export function isImageFile(filepath) {
  const ext = filepath.toLowerCase().substring(filepath.lastIndexOf('.'));
  return IMAGE_EXTENSIONS.has(ext);
}

export function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) tokens += 0.25;
    else if (c < 2048) tokens += 0.5;
    else tokens += 0.75;
  }
  return Math.ceil(tokens) + 3;
}

export function getTokenCache() {
  if (!existsSync(TOKEN_CACHE_PATH)) return { totalInput: 0, totalOutput: 0, totalCost: 0 };
  try { return JSON.parse(readFileSync(TOKEN_CACHE_PATH, 'utf-8')); }
  catch { return { totalInput: 0, totalOutput: 0, totalCost: 0 }; }
}

export function updateTokenCache(input, output, cost) {
  const cache = getTokenCache();
  cache.totalInput += input;
  cache.totalOutput += output;
  cache.totalCost += cost;
  ensureConfigDir();
  writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(cache));
}

export function getSystemPrompt(instructions) {
  const prov = getProvider();
  const isLocal = prov === 'ollama' || prov === 'lmstudio';
  let prompt = `You are Codex CLI, an AI coding agent running on the user's device. You have full access to files and shell.

CRITICAL: Never repeat yourself. Each response must be different from the last. Vary your wording, structure, and approach. If you catch yourself starting to say the same thing, stop and rephrase.

Available tools: read, write, edit, bash, glob, grep, ls, append, move, delete.
Use tools when you need to interact with files or shell. For simple chat just reply naturally.`;

  if (isLocal) {
    prompt += `

When using tools, output JSON like:
{"tool":"read","args":{"path":"file.js"}}
{"tool":"write","args":{"path":"file.js","content":"..."}}
{"tool":"edit","args":{"path":"file.js","oldString":"...","newString":"..."}}
{"tool":"bash","args":{"command":"ls","description":"list files"}}`;
  }

  prompt += `

Rules:
- Vary every response — different words, different sentence structure
- Keep responses concise unless the user asks for detail
- If a tool returns similar results, try a different approach
- No repetitive loops — do the task and stop
- For code edits: explain what changed briefly, don't narrate the process`;

  if (instructions) prompt += `\n\nProject Instructions:\n${instructions}`;
  return prompt;
}
