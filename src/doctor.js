import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  loadConfig, getApiKey, getProvider, getModel,
  getRawModel, getBaseUrl, isOllamaRunning, isLmStudioRunning,
  getTokenCache,
} from './config.js';
import { Session } from './session.js';

function check(label, ok, detail) {
  const icon = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${icon} \x1b[1m${label}\x1b[0m`);
  if (detail) console.log(`     ${detail}`);
}

function getVersion(cmd) {
  try {
    return execSync(`${cmd} --version 2>&1`, { encoding: 'utf-8', timeout: 2000 }).split('\n')[0].trim();
  } catch { return null; }
}

export async function runDoctor() {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
  );

  console.log(`\n  \x1b[1;36mCodex Doctor\x1b[0m \x1b[90mv${pkg.version} · ${process.platform}-${process.arch}\x1b[0m\n`);

  console.log('  \x1b[90m── Environment ──\x1b[0m');
  check('Platform', true, `${process.platform} ${process.arch} | node ${process.version}`);
  check('CODEX_HOME', existsSync(join(homedir(), '.codex')), `~/.codex`);

  console.log('\n  \x1b[90m── Configuration ──\x1b[0m');
  const cfg = loadConfig();
  const hasConfig = Object.keys(cfg).length > 0;
  check('Config file', hasConfig, hasConfig ? `~/.codex/config.json (${Object.keys(cfg).length} keys)` : 'not found (using defaults)');
  check('Provider', true, `${getProvider()} / ${getModel()} (${getRawModel()})`);
  check('Base URL', true, getBaseUrl());
  check('API key', !!getApiKey(), getApiKey() ? `set (${getApiKey().substring(0, 8)}...)` : 'not set');

  console.log('\n  \x1b[90m── Local Providers ──\x1b[0m');
  const ollamaOk = isOllamaRunning();
  check('Ollama', ollamaOk, ollamaOk ? 'running at http://localhost:11434' : 'not detected');
  const lmstudioOk = isLmStudioRunning();
  check('LMStudio', lmstudioOk, lmstudioOk ? 'running at http://localhost:1234' : 'not detected');

  console.log('\n  \x1b[90m── Tools ──\x1b[0m');
  const hasGit = !!getVersion('git');
  check('git', hasGit, hasGit ? getVersion('git') : 'not found');
  const hasCurl = !!getVersion('curl');
  check('curl', hasCurl, hasCurl ? getVersion('curl') : 'not found (wget fallback)');
  const hasWget = !!getVersion('wget');
  if (!hasCurl) check('wget', hasWget, hasWget ? getVersion('wget') : 'not found');
  const hasRg = !!getVersion('rg');
  check('ripgrep', hasRg, hasRg ? getVersion('rg') : 'not found (grep fallback)');

  console.log('\n  \x1b[90m── Token Usage ──\x1b[0m');
  const cache = getTokenCache();
  check('Total tokens', cache.totalInput > 0 || cache.totalOutput > 0,
    `${cache.totalInput} in / ${cache.totalOutput} out`);
  const cost = cache.totalCost;
  check('Total cost', true, cost === 0 ? '\x1b[32m$0 (FREE)\x1b[0m' : `\$${cost.toFixed(6)}`);

  console.log('\n  \x1b[90m── Sessions ──\x1b[0m');
  const sessions = Session.listAll();
  check('Session count', true, `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`);
  if (sessions.length > 0) {
    const totalMsgs = sessions.reduce((sum, s) => sum + (s.messages?.length || 0), 0);
    check('Total messages', true, `${totalMsgs} messages across all sessions`);
    const newest = sessions.reduce((a, b) => (a.updated > b.updated ? a : b), sessions[0]);
    check('Last active', true, `${new Date(newest.updated).toLocaleString()} (${newest.id.substring(0, 8)})`);
  }

  if (getProvider() !== 'opencode') {
    console.log('\n  \x1b[90m── Connectivity ──\x1b[0m');
    try {
      execSync(`curl -s -o /dev/null -w "%{http_code}" "${getBaseUrl().replace('/v1', '')}" --max-time 5 2>&1`, { timeout: 8000 });
      check('API reachable', true, getBaseUrl());
    } catch {
      check('API reachable', false, `${getBaseUrl()} - unreachable`);
    }
  }

  console.log('\n  \x1b[90m── CWD ──\x1b[0m');
  check('Working directory', true, process.cwd());

  console.log();
}
