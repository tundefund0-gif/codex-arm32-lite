import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const CODEX_HOME = join(homedir(), '.codex');
const SESSIONS_DIR = join(CODEX_HOME, 'sessions');
const PROJECT_CONFIG_DIR = '.codex';

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export class Session {
  constructor(id, cwd) {
    this.id = id || randomUUID();
    this.cwd = cwd || process.cwd();
    this.messages = [];
    this.created = Date.now();
    this.updated = Date.now();
    this.metadata = {};
  }

  get dir() {
    return join(SESSIONS_DIR, this.id);
  }

  get path() {
    return join(this.dir, 'session.json');
  }

  save() {
    this.updated = Date.now();
    ensureDir(this.dir);
    writeFileSync(this.path, JSON.stringify({
      id: this.id,
      cwd: this.cwd,
      created: this.created,
      updated: this.updated,
      metadata: this.metadata,
      messages: this.messages,
    }, null, 2));
  }

  static load(id) {
    const path = join(SESSIONS_DIR, id, 'session.json');
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      const s = new Session(data.id, data.cwd);
      s.messages = data.messages || [];
      s.created = data.created;
      s.updated = data.updated;
      s.metadata = data.metadata || {};
      return s;
    } catch {
      return null;
    }
  }

  static list(cwd) {
    ensureDir(SESSIONS_DIR);
    const entries = readdirSync(SESSIONS_DIR);
    const sessions = [];
    for (const id of entries) {
      const s = Session.load(id);
      if (s) {
        if (!cwd || s.cwd === cwd) {
          sessions.push(s);
        }
      }
    }
    sessions.sort((a, b) => b.updated - a.updated);
    return sessions;
  }

  static listAll() {
    return Session.list();
  }
}

export function getProjectConfigDir(cwd) {
  return resolve(cwd, PROJECT_CONFIG_DIR);
}

export function loadProjectConfig(cwd) {
  const configDir = getProjectConfigDir(cwd);
  const configPath = join(configDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {}
  }
  return {};
}

export function loadProjectInstructions(cwd) {
  const configDir = getProjectConfigDir(cwd);
  const instructionsPath = join(configDir, 'instructions.md');
  if (existsSync(instructionsPath)) {
    return readFileSync(instructionsPath, 'utf-8');
  }
  return null;
}

export function loadCodexIgnore(cwd) {
  const configDir = getProjectConfigDir(cwd);
  const ignorePath = join(configDir, 'codexignore');
  if (existsSync(ignorePath)) {
    return readFileSync(ignorePath, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
  }
  return [];
}

export function deleteSession(id) {
  const dir = join(SESSIONS_DIR, id);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
    return true;
  }
  return false;
}
