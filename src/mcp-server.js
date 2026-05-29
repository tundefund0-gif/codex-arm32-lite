import { tools, executeToolCall, addAllowedRoot, setYoloMode } from './tools.js';
import { getSystemPrompt, getProvider, getModel, getTokenCache } from './config.js';
import { Session, loadProjectInstructions } from './session.js';
import { chatWithTools } from './openai.js';

const TOOLS_DEFINITION = tools.map(t => ({
  name: t.name, description: t.description, parameters: t.parameters,
}));

let currentSession = new Session(null, process.cwd());

let stdinBuf = '';
let stdinResolve = null;
let lineQueue = [];

function flushQueue() {
  while (lineQueue.length > 0 && stdinResolve) {
    const line = lineQueue.shift();
    const r = stdinResolve;
    stdinResolve = null;
    try { r(JSON.parse(line)); } catch { r(null); }
  }
}

function onStdinData(chunk) {
  stdinBuf += chunk.toString();
  while (true) {
    const idx = stdinBuf.indexOf('\n');
    if (idx === -1) break;
    lineQueue.push(stdinBuf.slice(0, idx));
    stdinBuf = stdinBuf.slice(idx + 1);
  }
  flushQueue();
}

function recv() {
  return new Promise(resolve => {
    stdinResolve = resolve;
    flushQueue();
  });
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

export async function startMcpServer() {
  setYoloMode(true);
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', onStdinData);

  while (true) {
    const msg = await recv();
    if (!msg) continue;

    const { id, method, params } = msg;

    if (method === 'initialize') {
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: { name: 'codex-arm32', version: '0.4.0' },
        },
      });
      continue;
    }

    if (method === 'notifications/initialized') continue;

    if (method === 'tools/list') {
      send({
        jsonrpc: '2.0', id,
        result: { tools: TOOLS_DEFINITION },
      });
      continue;
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      try {
        const tool = tools.find(t => t.name === name);
        if (!tool) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
          continue;
        }
        const result = await tool.execute(args);
        send({
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
          },
        });
      } catch (err) {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
      }
      continue;
    }

    if (method === 'resources/list') {
      send({
        jsonrpc: '2.0', id,
        result: { resources: [] },
      });
      continue;
    }

    if (method === 'codex/chat') {
      try {
        const { message } = params;
        currentSession.messages.push({ role: 'user', content: message });
        const instructions = loadProjectInstructions(process.cwd());
        const systemMsg = { role: 'system', content: getSystemPrompt(instructions) };
        const chatMessages = [systemMsg, ...currentSession.messages];
        chatMessages.splice(1, 0, { role: 'system', content: `CWD: ${process.cwd()} | ${process.platform} ${process.arch}` });

        const { content, toolCalls } = await chatWithTools(chatMessages, TOOLS_DEFINITION);
        let toolResults = [];
        if (toolCalls && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const result = await executeToolCall(tc, 'full-access');
            currentSession.messages.push(result);
            toolResults.push({ name: tc.function.name, result: result.content });
          }
          const asstMsg = {
            role: 'assistant', content: content || null,
            tool_calls: toolCalls.map(tc => ({
              id: tc.id, type: 'function',
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          };
          currentSession.messages.push(asstMsg);
        } else if (content) {
          currentSession.messages.push({ role: 'assistant', content });
        }

        currentSession.save();
        send({
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: content || '' }],
            toolResults,
            sessionId: currentSession.id,
          },
        });
      } catch (err) {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
      }
      continue;
    }

    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
}
