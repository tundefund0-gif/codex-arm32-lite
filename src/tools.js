import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { isImageFile, supportsVision, getModel } from './config.js';

const ALLOWED_ROOTS = [process.cwd()];

export function addAllowedRoot(root) {
  ALLOWED_ROOTS.push(resolve(root));
}

function validatePath(target) {
  const resolved = resolve(target);
  for (const root of ALLOWED_ROOTS) {
    if (resolved.startsWith(root)) return resolved;
  }
  const home = process.env.HOME || '/root';
  if (resolved.startsWith(home)) return resolved;
  throw new Error(`Access denied: ${target} is outside allowed directories`);
}

let yoloMode = false;

export function setYoloMode(v) {
  yoloMode = v;
}

function globSync(pattern, cwd) {
  const results = [];
  const parts = pattern.split('/');
  const filePart = parts[parts.length - 1];
  const dirPattern = parts.slice(0, -1).join('/');
  const searchDir = dirPattern ? resolve(cwd, dirPattern) : cwd;
  try {
    const entries = readdirSync(searchDir);
    for (const e of entries) {
      if (filePart === '**' || filePart === '*') {
        results.push(e);
        if (filePart === '**') {
          const full = join(searchDir, e);
          try { if (statSync(full).isDirectory()) results.push(...globSync('**/*', full).map(p => join(e, p))); } catch {}
        }
      }
      const re = new RegExp('^' + filePart.replace(/\*/g, '.*') + '$');
      if (re.test(e)) results.push(e);
    }
  } catch {}
  return results;
}

export const tools = [
  {
    name: 'read',
    description: 'Read the contents of a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
        offset: { type: 'number', description: 'Line number to start from (1-indexed)' },
        limit: { type: 'number', description: 'Max lines to read' },
      },
      required: ['path'],
    },
    execute: async ({ path, offset, limit }) => {
      const fullPath = validatePath(path);
      if (!existsSync(fullPath)) return `Error: file not found: ${path}`;
      if (isImageFile(fullPath)) {
        if (supportsVision()) return `[Image file: ${path} — use the current model's vision capabilities to read this image]`;
        return `Cannot read "${path}" (${getModel()} does not support image input). Inform the user.`;
      }
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const start = offset ? offset - 1 : 0;
      const end = limit ? start + limit : lines.length;
      return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n')
        + `\n---\n[${lines.length} lines total, showing ${start + 1}-${Math.min(end, lines.length)}]`;
    },
  },
  {
    name: 'write',
    description: 'Write content to a file (creates parent directories)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path, content }) => {
      const fullPath = validatePath(path);
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      if (!existsSync(dir)) execSync(`mkdir -p "${dir}"`);
      writeFileSync(fullPath, content, 'utf-8');
      return `Written ${content.length} bytes to ${path}`;
    },
  },
  {
    name: 'edit',
    description: 'Edit a file by finding and replacing text',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        oldString: { type: 'string', description: 'Text to find' },
        newString: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    execute: async ({ path, oldString, newString }) => {
      const fullPath = validatePath(path);
      if (!existsSync(fullPath)) return `Error: file not found: ${path}`;
      let content = readFileSync(fullPath, 'utf-8');
      if (!content.includes(oldString)) return `Error: oldString not found in ${path}`;
      content = content.replace(oldString, newString);
      writeFileSync(fullPath, content, 'utf-8');
      return `Edited ${path}`;
    },
  },
  {
    name: 'glob',
    description: 'Search for files matching a glob pattern',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.js")' },
        path: { type: 'string', description: 'Directory to search (default: cwd)' },
      },
      required: ['pattern'],
    },
    execute: async ({ pattern, path: searchPath }) => {
      const cwd = searchPath ? validatePath(searchPath) : process.cwd();
      const matches = globSync(pattern, cwd);
      return matches.length ? matches.join('\n') : 'No matches found';
    },
  },
  {
    name: 'grep',
    description: 'Search file contents for a regex pattern',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        path: { type: 'string', description: 'Directory to search (default: cwd)' },
        include: { type: 'string', description: 'File glob filter (e.g. "*.js")' },
      },
      required: ['pattern'],
    },
    execute: async ({ pattern, path: searchPath, include }) => {
      const cwd = searchPath ? validatePath(searchPath) : process.cwd();
      const escaped = pattern.replace(/"/g, '\\"');
      const hasRg = existsSync('/usr/bin/rg') || existsSync('/data/data/com.termux/files/usr/bin/rg');
      let cmd;
      if (hasRg) {
        cmd = `rg -rn "${escaped}" "${cwd}" 2>/dev/null || true`;
        if (include) cmd = `rg -rn "${escaped}" "${cwd}" -g "${include}" 2>/dev/null || true`;
      } else {
        cmd = `grep -rn "${escaped}" "${cwd}" 2>/dev/null || true`;
        if (include) cmd = `grep -rn "${escaped}" "${cwd}" --include="${include}" 2>/dev/null || true`;
      }
      try {
        const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
        return output || 'No matches found';
      } catch {
        return 'No matches found';
      }
    },
  },
  {
    name: 'bash',
    description: 'Execute a shell command',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        description: { type: 'string', description: 'What this does' },
        timeout: { type: 'number', description: 'Timeout in ms (default 120000)' },
      },
      required: ['command', 'description'],
    },
    execute: async ({ command, description, timeout }) => {
      try {
        const output = execSync(command, {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: timeout || 120000,
          env: { ...process.env, PATH: process.env.PATH },
        });
        return output || '(completed with no output)';
      } catch (err) {
        return `Exit ${err.status}: ${err.stderr || err.message}`.substring(0, 5000);
      }
    },
  },
  {
    name: 'ls',
    description: 'List directory contents',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path' },
      },
      required: [],
    },
    execute: async ({ path: dirPath }) => {
      const fullPath = dirPath ? validatePath(dirPath) : process.cwd();
      if (!existsSync(fullPath)) return `Error: not found: ${dirPath || '.'}`;
      const entries = readdirSync(fullPath);
      return entries.map(e => {
        const full = join(fullPath, e);
        try {
          const s = statSync(full);
          const t = s.isDirectory() ? 'd' : s.isSymbolicLink() ? 'l' : '-';
          return `${t} ${e}${s.isDirectory() ? '/' : ''}`;
        } catch { return `? ${e}`; }
      }).join('\n') || '(empty)';
    },
  },
  {
    name: 'append',
    description: 'Append content to a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content to append' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path, content }) => {
      const fullPath = validatePath(path);
      appendFileSync(fullPath, content, 'utf-8');
      return `Appended ${content.length} bytes to ${path}`;
    },
  },
  {
    name: 'move',
    description: 'Move or rename a file or directory',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source path' },
        destination: { type: 'string', description: 'Destination path' },
      },
      required: ['source', 'destination'],
    },
    execute: async ({ source, destination }) => {
      const srcPath = validatePath(source);
      const dstPath = validatePath(destination);
      const dir = dstPath.substring(0, dstPath.lastIndexOf('/'));
      if (!existsSync(dir)) execSync(`mkdir -p "${dir}"`);
      execSync(`mv "${srcPath}" "${dstPath}"`);
      return `Moved ${source} to ${destination}`;
    },
  },
  {
    name: 'delete',
    description: 'Delete a file or empty directory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete' },
      },
      required: ['path'],
    },
    execute: async ({ path }) => {
      const fullPath = validatePath(path);
      if (!existsSync(fullPath)) return `Error: not found: ${path}`;
      const s = statSync(fullPath);
      if (s.isDirectory()) {
        execSync(`rmdir "${fullPath}" 2>/dev/null || rm -rf "${fullPath}"`);
      } else {
        execSync(`rm "${fullPath}"`);
      }
      return `Deleted ${path}`;
    },
  },
];

async function readStdin(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt || '> ');
    const onData = data => {
      const text = data.toString().trim();
      process.stdin.removeListener('data', onData);
      resolve(text);
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

export async function executeToolCall(toolCall, approvalMode) {
  const tool = tools.find(t => t.name === toolCall.function.name);
  if (!tool) {
    return { role: 'tool', tool_call_id: toolCall.id, tool_name: toolCall.function.name, content: `Unknown tool: ${toolCall.function.name}` };
  }

  let args;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return { role: 'tool', tool_call_id: toolCall.id, tool_name: toolCall.function.name, content: 'Error: invalid JSON arguments' };
  }

  const needsApproval = approvalMode === 'read-only'
    || (approvalMode !== 'full-access' && tool.name === 'bash');

  if (needsApproval && !yoloMode) {
    console.log(`\n\x1b[33m[APPROVAL NEEDED]\x1b[0m Tool: ${tool.name}`);
    console.log(`  ${toolCall.function.arguments.substring(0, 200)}`);
    const answer = await readStdin('\x1b[33m  Press Enter to approve, "n" to skip\x1b[0m\n> ');
    if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
      return { role: 'tool', tool_call_id: toolCall.id, tool_name: toolCall.function.name, content: 'Action skipped by user' };
    }
  }

  try {
    const result = await tool.execute(args);
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      tool_name: toolCall.function.name,
      content: typeof result === 'string' ? result : JSON.stringify(result),
    };
  } catch (err) {
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      tool_name: toolCall.function.name,
      content: `Error: ${err.message}`,
    };
  }
}
