import OpenAI from 'openai';
import { getApiKey, getModel, getBaseUrl, getProvider, estimateTokens, getPricing, updateTokenCache } from './config.js';

let client = null;
let provider = null;

function getClient() {
  const currentProvider = getProvider();
  const baseURL = getBaseUrl();
  if (client && provider === currentProvider && baseURL === client.baseURL) return client;
  provider = currentProvider;

  const config = { baseURL };
  if (currentProvider === 'ollama' || currentProvider === 'lmstudio') {
    config.apiKey = currentProvider;
  } else if (currentProvider === 'opencode') {
    config.apiKey = process.env.OPENCODE_API_KEY || 'public';
  } else {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('No API key. Use CODEX_API_KEY env or run: codex auth <key>');
    config.apiKey = apiKey;
  }

  client = new OpenAI(config);
  return client;
}

const MAX_RETRIES = 2;

async function retryableCreate(openai, params, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await openai.chat.completions.create(params);
    } catch (err) {
      const isRetryable = err.status === 429 || err.status === 500 || err.status === 503 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (attempt < retries && isRetryable) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

export async function chatWithTools(messages, tools, onChunk) {
  const openai = getClient();
  const model = getModel();
  const currentProvider = provider;

  const apiTools = (currentProvider === 'ollama' || currentProvider === 'lmstudio') ? undefined : tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  let totalInput = 0;
  for (const m of messages) {
    totalInput += estimateTokens(m.content || '');
    if (m.tool_calls) {
      for (const tc of m.tool_calls) totalInput += estimateTokens(tc.function.name + tc.function.arguments);
    }
  }

  let fullContent = '';
  let reasoningContent = '';
  let toolCalls = [];

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIdx = 0;
  let spinnerTimer = null;
  let started = false;

  function startSpinner() {
    process.stdout.write('\x1b[90m');
    spinnerTimer = setInterval(() => {
      process.stdout.write(`\r${spinnerFrames[spinnerIdx]} thinking...\x1b[0m`);
      spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
    }, 80);
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      process.stdout.write('\r\x1b[K\x1b[0m');
    }
  }

  try {
    startSpinner();
    const stream = await retryableCreate(openai, {
      model,
      messages: messages,
      tools: apiTools,
      tool_choice: apiTools ? 'auto' : undefined,
      stream: true,
      temperature: 0.4,
    });

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      if (!started) { stopSpinner(); started = true; }

      if (delta?.content) {
        fullContent += delta.content;
        if (onChunk) onChunk(delta.content);
      }

      const rc = delta?.reasoning_content;
      if (rc) reasoningContent += rc;

      if (delta?.tool_calls && apiTools) {
        for (const tc of delta.tool_calls) {
          if (tc.index !== undefined) {
            if (!toolCalls[tc.index]) {
              toolCalls[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.id) toolCalls[tc.index].id += tc.id;
            if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
          }
        }
      }
    }
    if (!started) stopSpinner();
  } catch (err) {
    stopSpinner();
    const status = err.status || err.code || '';
    const msg = err.error?.error?.message || err.message || 'Unknown error';
    if (status === 401) {
      throw new Error(`401 Unauthorized: ${currentProvider === 'opencode' ? 'OpenCode Zen rejected key. Try: OPENCODE_API_KEY=your_key codex' : 'Invalid API key. Run: codex auth <key>'}`);
    }
    if (status === 402) {
      throw new Error(`402 Payment Required: The model requires billing. Try a free model like opencode/big-pickle.`);
    }
    throw new Error(`${status} Error from provider (${currentProvider}): ${msg}`);
  }

  const outputTokens = estimateTokens(fullContent);
  totalInput += outputTokens;

  const pricing = getPricing(model);
  const isFree = currentProvider === 'ollama' || currentProvider === 'lmstudio' || currentProvider === 'opencode';
  const cost = isFree ? 0 : (totalInput * pricing.input + outputTokens * pricing.output) / 1_000_000;
  updateTokenCache(totalInput, outputTokens, cost);

  let parsedCalls = toolCalls.filter(Boolean);

  if ((currentProvider === 'ollama' || currentProvider === 'lmstudio') && fullContent) {
    parsedCalls = await parseLocalToolCalls(fullContent);
  }

  return { content: fullContent, reasoningContent, toolCalls: parsedCalls, usage: { input: totalInput, output: outputTokens, cost } };
}

async function parseLocalToolCalls(content) {
  const calls = [];
  const seen = new Set();
  const seenPatterns = new Map();

  const jsonRegex = /\{(?:[^{}]|"(?:\\.|[^"\\])*")*}/g;
  let match;
  while ((match = jsonRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === 'object' && parsed.tool && parsed.args) {
        const key = parsed.tool + JSON.stringify(parsed.args);
        if (seen.has(key)) continue;
        seen.add(key);

        const toolOnlyKey = parsed.tool;
        const count = (seenPatterns.get(toolOnlyKey) || 0) + 1;
        seenPatterns.set(toolOnlyKey, count);
        if (count > 5) continue;

        calls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          type: 'function',
          function: { name: parsed.tool, arguments: JSON.stringify(parsed.args) },
        });
      }
    } catch {}
  }

  if (calls.length === 0) {
    const bashMatch = content.match(/```(?:bash|sh|shell)\s*\n([\s\S]*?)```/);
    if (bashMatch) {
      calls.push({
        id: `call_${Date.now()}`,
        type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: bashMatch[1].trim(), description: 'extracted from code block' }) },
      });
    }
  }

  return calls;
}
