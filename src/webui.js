import http from 'http';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { chatWithTools } from './openai.js';
import { tools, executeToolCall } from './tools.js';
import { getSystemPrompt, getProvider, getModel, getTokenCache } from './config.js';
import { Session, loadProjectInstructions, deleteSession } from './session.js';

const TOOLS_DEFINITION = tools.map(t => ({
  name: t.name, description: t.description, parameters: t.parameters,
}));

const HTML = readFileSync(join(import.meta.dirname, 'index.html'), 'utf-8');

let currentSession = null;
let currentAbort = null;

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function listSessions() {
  return Session.list().map(s => ({
    id: s.id,
    created: s.created,
    updated: s.updated,
    preview: (s.messages?.find(m => m.role === 'user')?.content || '').substring(0, 80),
    msgCount: s.messages?.length || 0,
  }));
}

function listSkills() {
  const searchRoots = [
    join(homedir(), '.opencode', 'skills'),
    join(homedir(), '.codex', 'skills'),
    join(homedir(), '.shared-skills'),
  ];
  const seen = new Set();
  const results = [];

  function scan(dir, depth = 0) {
    if (depth > 4 || !existsSync(dir)) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (existsSync(join(full, 'SKILL.md'))) {
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        const content = readFileSync(join(full, 'SKILL.md'), 'utf-8').substring(0, 200);
        const description = content.replace(/^#\s+/, '').split('\n')[0] || '';
        results.push({ name: entry.name, path: full, hasSkillMd: true, description: description.substring(0, 120) });
      }
      scan(full, depth + 1);
    }
  }

  for (const root of searchRoots) scan(root);
  return results;
}

export function startWebUI(port = 5000) {
  currentSession = null;

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listSessions()));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/skills') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listSkills()));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const cache = getTokenCache();
      res.end(JSON.stringify({
        provider: getProvider(),
        model: getModel(),
        sessionId: currentSession?.id || null,
        msgCount: currentSession?.messages?.length || 0,
        cost: cache.totalCost,
        tokensIn: cache.totalInput,
        tokensOut: cache.totalOutput,
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/session/new') {
      currentSession?.save();
      currentSession = new Session(null, process.cwd());
      currentSession.save();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: currentSession.id }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/session/load') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          const loaded = Session.load(id);
          if (loaded) {
            currentSession = loaded;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: loaded.id,
              messages: loaded.messages,
              created: loaded.created,
              updated: loaded.updated,
            }));
          } else {
            res.writeHead(404);
            res.end('Not found');
          }
        } catch {
          res.writeHead(400);
          res.end('Bad request');
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/session/delete') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          const ok = deleteSession(id);
          res.writeHead(ok ? 200 : 404);
          res.end(ok ? 'ok' : 'Not found');
        } catch {
          res.writeHead(400);
          res.end('Bad request');
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/stop') {
      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
      }
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (req.method === 'POST' && req.url === '/api/chat') {
      handleChat(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`\n  \x1b[1;36mCodex Web UI\x1b[0m\n`);
    process.stdout.write(`  \x1b[90m→\x1b[0m \x1b[4mhttp://localhost:${port}\x1b[0m\n\n`);
  });

  return server;
}

async function handleChat(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { message, sessionId } = JSON.parse(body);

      if (!currentSession || (sessionId && currentSession.id !== sessionId)) {
        const loaded = sessionId ? Session.load(sessionId) : null;
        currentSession = loaded || new Session(null, process.cwd());
      }

      currentSession.messages.push({ role: 'user', content: message });
      currentSession.save();

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      sendSSE(res, { type: 'session', id: currentSession.id });
      sendSSE(res, { type: 'status', provider: getProvider(), model: getModel(), msgs: currentSession.messages.length, cost: getTokenCache().totalCost });

      currentAbort = new AbortController();

      try {
        await runAgentWeb(currentSession.messages, res, currentAbort.signal);
      } catch (err) {
        if (err.name === 'AbortError') {
          sendSSE(res, { type: 'stopped' });
        } else {
          sendSSE(res, { type: 'error', content: err.message });
        }
      }

      currentAbort = null;
      currentSession.save();
      sendSSE(res, { type: 'done' });
      res.end();
    } catch (err) {
      res.writeHead(400);
      res.end('Invalid request');
    }
  });
}

async function runAgentWeb(messages, res, signal) {
  let loopCount = 0;
  do {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const instructions = loadProjectInstructions(process.cwd());
    const systemMsg = { role: 'system', content: getSystemPrompt(instructions) };
    const chatMessages = [systemMsg, ...messages];
    chatMessages.splice(1, 0, { role: 'system', content: `CWD: ${process.cwd()} | ${process.platform} ${process.arch}` });

    const { content, reasoningContent, toolCalls } = await chatWithTools(chatMessages, TOOLS_DEFINITION, (chunk) => {
      if (signal?.aborted) return;
      sendSSE(res, { type: 'token', content: chunk });
    });

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (content) {
      const last = messages[messages.length - 1];
      const msg = { role: 'assistant', content };
      if (reasoningContent) {
        msg.reasoning_content = reasoningContent;
        sendSSE(res, { type: 'reasoning', content: reasoningContent });
      }
      if (last?.role === 'assistant' && !last.tool_calls) Object.assign(last, msg);
      else messages.push(msg);
    }

    if (!toolCalls || toolCalls.length === 0) return;

    const asstMsg = {
      role: 'assistant', content: content || null,
      reasoning_content: reasoningContent || null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };

    if (messages[messages.length - 1]?.role === 'assistant' && messages[messages.length - 1]?.tool_calls) {
      messages[messages.length - 1] = asstMsg;
    } else messages.push(asstMsg);

    for (const tc of toolCalls) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      sendSSE(res, { type: 'tool_start', name: tc.function.name, args: tc.function.arguments });
      const resultMsg = await executeToolCall(tc, 'full-access');
      messages.push(resultMsg);
      sendSSE(res, { type: 'tool_end', name: tc.function.name, result: resultMsg.content });
    }

    loopCount++;
    if (loopCount > 25) break;
    if (messages.filter(m => m.role === 'tool').length > 100) break;
  } while (true);
}
