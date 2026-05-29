import { exit } from 'process';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { chatWithTools } from './openai.js';
import { tools, executeToolCall, addAllowedRoot, setYoloMode } from './tools.js';
import {
  getSystemPrompt, getApiKey, setApiKey, setModel,
  getModel, getRawModel, getProvider, getModelPrefix,
  getApprovalMode, setApprovalMode,
  loadConfig, getTokenCache, isOllamaRunning, resetOllamaCheck,
  getDefaultOssModel, isLmStudioRunning,
} from './config.js';
import { Session, loadProjectInstructions } from './session.js';
import { startWebUI } from './webui.js';

const TOOLS_DEFINITION = tools.map(t => ({
  name: t.name, description: t.description, parameters: t.parameters,
}));

let approvalMode = 'full-access';
let yoloMode = true;
let currentSession = null;
let workingDir = process.cwd();
let extraDirs = [];

function readLineRaw(promptStr) {
  return new Promise(resolve => {
    const buf = [];
    let lastDataTime = 0;
    process.stdout.write(promptStr);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (!wasRaw) stdin.setRawMode(true);
    stdin.resume();

    function submit() {
      stdin.setRawMode(!!wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      resolve(buf.join(''));
    }

    const onData = data => {
      const now = Date.now();

      let isEnter = true;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 10 && data[i] !== 13) { isEnter = false; break; }
      }

      if (isEnter) {
        process.stdout.write('\n');
        if (now - lastDataTime < 80) {
          lastDataTime = now;
          buf.push('\n');
        } else {
          submit();
        }
        return;
      }

      lastDataTime = now;

      for (const byte of data) {
        if (byte === 127 || byte === 8) {
          if (buf.length > 0) { buf.pop(); process.stdout.write('\b \b'); }
          continue;
        }
        if (byte === 3) { process.stdout.write('^C\n'); currentSession?.save(); exit(0); }
        const c = String.fromCharCode(byte);
        buf.push(c);
        process.stdout.write(c);
      }
    };
    stdin.on('data', onData);
  });
}

function formatCost(cost) {
  if (cost === 0) return '\x1b[32mFREE\x1b[0m';
  return `\$${cost.toFixed(6)}`;
}

function showDashboard() {
  const cache = getTokenCache();
  const p = getProvider();
  const m = getModel();
  const ollamaOk = isOllamaRunning();
  const tag = p === 'openai' ? 'OpenAI' : p === 'opencode' ? 'Zen FREE' : p === 'ollama' ? (ollamaOk ? 'Ollama' : 'offline') : p === 'lmstudio' ? 'LMStudio' : 'offline';
  const color = cache.totalCost === 0 ? '\x1b[32m' : '\x1b[36m';

  console.clear();
  console.log(`\x1b[1;36m`);
  console.log(`  ╔═══════════════════════════════════════════╗`);
  console.log(`  ║        \x1b[1;37mCodex CLI\x1b[1;36m - AI Coding Agent        ║`);
  console.log(`  ╚═══════════════════════════════════════════╝`);
  console.log(`\x1b[0m`);
  console.log(`  \x1b[90mProvider:\x1b[0m  ${p}/${m} \x1b[90m|\x1b[0m ${tag}`);
  console.log(`  \x1b[90mSession:\x1b[0m  ${currentSession?.id?.substring(0, 8) || 'new'}  \x1b[90m|\x1b[0m  ${currentSession?.messages?.length || 0} msgs`);
  console.log(`  \x1b[90mTokens:\x1b[0m   ${color}${cache.totalInput} in\x1b[0m / ${color}${cache.totalOutput} out\x1b[0m  \x1b[90m|\x1b[0m  Cost: ${formatCost(cache.totalCost)}`);
  console.log(`  \x1b[90mMode:\x1b[0m    ${yoloMode ? '\x1b[31mYOLO\x1b[0m' : approvalMode === 'full-access' ? '\x1b[33mFull Access\x1b[0m' : approvalMode === 'read-only' ? '\x1b[33mRead Only\x1b[0m' : '\x1b[32mAuto\x1b[0m'}  \x1b[90m|\x1b[0m  \x1b[90mCWD:\x1b[0m ${process.cwd()}`);
  console.log(`  \x1b[90mPlatform:\x1b[0m ${process.platform} ${process.arch}\n`);
}

function showMiniStatus() {
  const cache = getTokenCache();
  const cost = cache.totalCost;
  const color = cost === 0 ? '\x1b[32m' : '\x1b[36m';
  const m = Math.min(currentSession?.messages?.length || 0, 99);
  console.log(`\x1b[90m[${m}msgs\x1b[0m ${color}$${cost.toFixed(4)}\x1b[0m\x1b[90m]\x1b[0m`);
}

export async function main(args) {
  if (args.length === 0) { await startInteractive(); return; }

  const command = args[0];

  if (command === 'auth') {
    const key = args[1];
    if (key && key.startsWith('sk-')) {
      setApiKey(key);
      console.log('\x1b[32m✓\x1b[0m API key saved.');
    } else if (key && (key.startsWith('ollama/') || key.startsWith('opencode/'))) {
      setModel(key);
      console.log(`\x1b[32m✓\x1b[0m Model set to ${key}.`);
    } else {
      console.log('\n  \x1b[1mChoose:\x1b[0m');
      console.log('    1. Enter OpenAI API key (sk-...)');
      console.log('    2. Use local Ollama model (ollama/qwen2.5:0.5b)');
      console.log('    3. Use free OpenCode model (opencode/big-pickle)');
      console.log('    4. Just press Enter for default\n');
      const a = await readLineRaw('  > ');
      if (a.startsWith('sk-')) {
        setApiKey(a);
        console.log('\x1b[32m✓\x1b[0m API key saved.');
      } else if (a.startsWith('ollama/')) {
        setModel(a);
        console.log(`\x1b[32m✓\x1b[0m Using ${a}. Make sure Ollama is running.`);
      } else if (a.startsWith('opencode/')) {
        setModel(a);
        console.log(`\x1b[32m✓\x1b[0m Using ${a} (free).`);
      } else {
        console.log('\x1b[33mℹ\x1b[0m Defaulting to opencode/big-pickle (free).');
        setModel('opencode/big-pickle');
      }
    }
    return;
  }

  if (command === 'resume') {
    const flag = args[1];
    if (flag === '--last') {
      const sessions = Session.list(process.cwd());
      if (sessions.length === 0) { console.log('No sessions.'); return; }
      currentSession = sessions[0];
      await resumeSession();
    } else if (flag === '--all') {
      await pickSession(Session.listAll());
    } else if (flag && !flag.startsWith('-')) {
      currentSession = Session.load(flag);
      if (!currentSession) { console.log('Session not found.'); return; }
      await resumeSession();
    } else {
      await pickSession(Session.list(process.cwd()));
    }
    return;
  }

  if (command === 'exec' || command === 'e') {
    approvalMode = 'full-access';
    setYoloMode(true);
    const prompt = args.slice(1).join(' ');
    if (!prompt) { console.log('Usage: codex exec "your prompt"'); return; }
    currentSession = new Session(null, process.cwd());
    await runAgent([{ role: 'user', content: prompt }]);
    currentSession.save();
    return;
  }

  if (command === 'completion') {
    console.log(generateCompletions(args[1] || 'bash'));
    return;
  }

  if (command === 'fork') {
    await pickSession(Session.list(process.cwd()), true);
    return;
  }

  if (command === 'web' || command === 'ui' || command === 'dashboard') {
    const port = parseInt(args[1]) || 5000;
    startWebUI(port);
    return;
  }

  if (command === 'mcp-server') {
    const { startMcpServer } = await import('./mcp-server.js');
    await startMcpServer();
    return;
  }

  if (command === 'doctor') {
    const { runDoctor } = await import('./doctor.js');
    await runDoctor();
    return;
  }

  if (command === 'features') {
    const action = args[1];
    if (action === 'list') {
      console.log('Provider:', getProvider());
      console.log('Model:', getModel());
      console.log('API key:', getApiKey() ? 'set' : 'not set');
      console.log('Ollama:', isOllamaRunning() ? 'running' : 'not detected');
    } else if (action === 'enable' && args[2] === 'yolo') {
      const cfg = loadConfig(); cfg.yolo = true;
      writeFileSync(join(process.env.HOME || '/root', '.codex/config.json'), JSON.stringify(cfg, null, 2));
      console.log('YOLO enabled.');
    } else if (action === 'disable' && args[2] === 'yolo') {
      const cfg = loadConfig(); cfg.yolo = false;
      writeFileSync(join(process.env.HOME || '/root', '.codex/config.json'), JSON.stringify(cfg, null, 2));
      console.log('YOLO disabled.');
    }
    return;
  }

  if (command === '--version' || command === '-v') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    console.log(`codex v${pkg.version}`);
    return;
  }

  if (command === '--help' || command === '-h') { showHelp(); return; }

  const parsed = parseFlags(args);
  if (parsed.cd) workingDir = parsed.cd;
  if (parsed.oss) {
    if (parsed.localProvider === 'ollama') setModel('ollama/qwen2.5:0.5b');
    else if (parsed.localProvider === 'lmstudio') setModel('lmstudio/local-model');
    else setModel(getDefaultOssModel());
  } else if (parsed.localProvider) {
    if (parsed.localProvider === 'ollama') setModel('ollama/qwen2.5:0.5b');
    else if (parsed.localProvider === 'lmstudio') setModel('lmstudio/local-model');
  }
  if (parsed.model) setModel(parsed.model);
  if (parsed.addDir) extraDirs = parsed.addDir;
  if (parsed.yolo) { yoloMode = true; setYoloMode(true); approvalMode = 'full-access'; }
  if (parsed.sandbox) approvalMode = parsed.sandbox === 'read-only' ? 'read-only' : 'auto';
  if (parsed.approval) approvalMode = parsed.approval;
  extraDirs.forEach(d => addAllowedRoot(d));

  if (parsed.prompt) {
    currentSession = new Session(null, workingDir);
    await runAgent([{ role: 'user', content: parsed.prompt }]);
    currentSession.save();
  } else {
    await startInteractive();
  }
}

function parseFlags(args) {
  const r = { prompt: '', cd: null, model: null, addDir: [], yolo: false, sandbox: null, images: [], approval: null, oss: false, localProvider: null };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--cd' || a === '-C') { r.cd = args[++i]; }
    else if (a === '--model' || a === '-m') { r.model = args[++i]; }
    else if (a === '--add-dir') { r.addDir.push(args[++i]); }
    else if (a === '--yolo' || a === '--dangerously-bypass-approvals-and-sandbox') { r.yolo = true; }
    else if (a === '--sandbox' || a === '-s') { r.sandbox = args[++i]; }
    else if (a === '--image' || a === '-i') { args[++i].split(',').forEach(f => r.images.push(f.trim())); }
    else if (a === '--ask-for-approval' || a === '-a') { r.approval = args[++i]; }
    else if (a === '--oss') { r.oss = true; }
    else if (a === '--local-provider') { r.localProvider = args[++i]; }
    else if (a === '--help' || a === '-h') { showHelp(); exit(0); }
    else if (a === '--version' || a === '-v') {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
      console.log(`codex v${pkg.version}`); exit(0);
    } else { r.prompt = args.slice(i).join(' '); break; }
    i++;
  }
  return r;
}

function showHelp() {
  console.log(`
\x1b[1;36mCodex CLI\x1b[0m - AI coding agent (ARM32, free models)

\x1b[1mUsage:\x1b[0m
  codex                          Interactive session
  codex <prompt>                 One-shot prompt
  codex auth [key|model]         Set API key or model
  codex exec <prompt>            Non-interactive mode
  codex resume [--last|--all|id] Resume a session
  codex fork                     Fork a session
  codex completion [shell]       Shell completions
  codex mcp-server               Start as MCP server (stdio)
  codex doctor                   Run diagnostics

\x1b[1mFlags:\x1b[0m
  -m, --model <model>         Model
  -C, --cd <path>             Working directory
  --oss                       Use open-source provider (Ollama/LMStudio)
  --local-provider <name>     Specify OSS provider (ollama or lmstudio)
  --yolo                      Skip all approvals
  -s, --sandbox <mode>        Approval mode
  --add-dir <path>            Extra writable dirs

\x1b[1mSlash commands:\x1b[0m
  /help  /status  /clear  /new  /model  /permissions
  /yolo  /diff  /cost  /compact  /save  /exit
`.trim());
}

function generateCompletions(shell) {
  if (shell === 'zsh') return '#codex completion zsh\n_codex() {\n  local -a commands\n  commands=(\n    \'auth:Set API key or model\'\n    \'resume:Resume session\'\n    \'exec:Non-interactive\'\n    \'completion:Generate completions\'\n    \'fork:Fork session\'\n    \'web:Start web UI\'\n    \'mcp-server:Start MCP server\'\n    \'doctor:Run diagnostics\'\n  )\n  _describe command commands\n}\ncompdef _codex codex';
  if (shell === 'bash') return '#codex completion bash\n_codex_completions() {\n  local commands="auth resume exec completion fork web mcp-server doctor"\n  COMPREPLY=($(compgen -W "$commands" -- "${COMP_WORDS[1]}"))\n}\ncomplete -F _codex_completions codex';
  if (shell === 'fish') return '#codex completion fish\ncomplete -c codex -f -a auth -d "Set API key or model"\ncomplete -c codex -f -a resume -d "Resume session"\ncomplete -c codex -f -a exec -d "Non-interactive mode"\ncomplete -c codex -f -a mcp-server -d "Start MCP server"\ncomplete -c codex -f -a doctor -d "Run diagnostics"';
  return '# unsupported shell';
}

async function startInteractive() {
  currentSession = new Session(null, workingDir);
  showDashboard();
  console.log('\x1b[90m  Paste text safely, press Enter to send. Type /help for commands.\x1b[0m\n');

  while (true) {
    const text = await readLineRaw('\x1b[36m>\x1b[0m ');
    if (!text) continue;
    if (text.startsWith('/')) { await handleSlashCommand(text); continue; }
    currentSession.messages.push({ role: 'user', content: text });
    await runAgent(currentSession.messages);
    currentSession.save();
    showMiniStatus();
  }
}

async function handleSlashCommand(text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '/help':
      console.log('\n\x1b[90m  Slash commands:\x1b[0m');
      console.log('    \x1b[36m/help\x1b[0m         Show this');
      console.log('    \x1b[36m/status\x1b[0m       Session stats');
      console.log('    \x1b[36m/clear\x1b[0m        Clear screen');
      console.log('    \x1b[36m/new\x1b[0m          New conversation');
      console.log('    \x1b[36m/model\x1b[0m <name> Switch model');
      console.log('    \x1b[36m/permissions\x1b[0m   Approval mode');
      console.log('    \x1b[36m/yolo\x1b[0m         Toggle full access');
      console.log('    \x1b[36m/diff\x1b[0m         Git diff');
      console.log('    \x1b[36m/cost\x1b[0m         Token usage');
      console.log('    \x1b[36m/compact\x1b[0m      Compact history');
      console.log('    \x1b[36m/save\x1b[0m         Save session');
      console.log('    \x1b[36m/exit\x1b[0m         Quit\n');
      break;
    case '/status':
    case '/session': {
      const cache = getTokenCache();
      console.log(`\n  \x1b[90mProvider:\x1b[0m ${getProvider()} / ${getModel()}`);
      console.log(`  \x1b[90mMode:\x1b[0m     ${yoloMode ? '\x1b[31mYOLO\x1b[0m' : approvalMode === 'full-access' ? '\x1b[33mFull Access\x1b[0m' : approvalMode === 'read-only' ? '\x1b[33mRead Only\x1b[0m' : '\x1b[32mAuto\x1b[0m'}`);
      console.log(`  \x1b[90mCWD:\x1b[0m      ${process.cwd()}`);
      console.log(`  \x1b[90mSession:\x1b[0m  ${currentSession?.id || 'none'}  \x1b[90m|\x1b[0m  ${currentSession?.messages?.length || 0} msgs`);
      console.log(`  \x1b[90mTokens:\x1b[0m   ${cache.totalInput} in / ${cache.totalOutput} out`);
      console.log(`  \x1b[90mCost:\x1b[0m     \$${cache.totalCost.toFixed(6)}\n`);
      break;
    }
    case '/clear':
      showDashboard();
      break;
    case '/new':
      currentSession.save();
      currentSession = new Session(null, workingDir);
      showDashboard();
      break;
    case '/model':
      if (parts[1]) { setModel(parts[1]); resetOllamaCheck(); console.log(`\x1b[32m✓\x1b[0m Model: ${parts[1]}`); }
      else console.log(`\x1b[36m${getRawModel()}\x1b[0m`);
      break;
    case '/permissions': {
      const modes = ['auto', 'read-only', 'full-access'];
      console.log('\n  \x1b[1mSelect mode:\x1b[0m');
      modes.forEach((m, i) => console.log(`    ${i + 1}. ${m}`));
      const a = await readLineRaw('\n  > ');
      const idx = parseInt(a) - 1;
      if (idx >= 0 && idx < modes.length) {
        approvalMode = modes[idx];
        setApprovalMode(modes[idx]);
        console.log(`\x1b[32m✓\x1b[0m Mode: \x1b[36m${modes[idx]}\x1b[0m`);
      }
      break;
    }
    case '/yolo':
      yoloMode = !yoloMode;
      setYoloMode(yoloMode);
      approvalMode = yoloMode ? 'full-access' : 'auto';
      console.log(yoloMode ? '\x1b[31mYOLO ON\x1b[0m' : '\x1b[32mYOLO OFF\x1b[0m');
      break;
    case '/diff':
      try {
        const { execSync } = await import('child_process');
        const out = execSync('git diff --stat 2>/dev/null; echo "---"; git diff 2>/dev/null; echo "---"; git diff --cached 2>/dev/null; echo "---"; git ls-files --others --exclude-standard 2>/dev/null', { encoding: 'utf-8' });
        if (out.trim()) console.log(out); else console.log('\x1b[90m(no changes)\x1b[0m');
      } catch { console.log('\x1b[90m(not a git repo)\x1b[0m'); }
      break;
    case '/cost':
    case '/tokens': {
      const cache = getTokenCache();
      const cost = cache.totalCost;
      console.log(`\n  \x1b[90mInput:\x1b[0m  ${cache.totalInput} tokens`);
      console.log(`  \x1b[90mOutput:\x1b[0m ${cache.totalOutput} tokens`);
      console.log(`  \x1b[90mCost:\x1b[0m   ${cost === 0 ? '\x1b[32mFREE\x1b[0m' : `\$${cost.toFixed(6)}`}\n`);
      break;
    }
    case '/compact': {
      if (currentSession.messages.length < 4) { console.log('\x1b[90mToo few messages.\x1b[0m'); break; }
      const systemIdx = currentSession.messages.findIndex(m => m.role === 'system');
      const keep = currentSession.messages.slice(systemIdx + 1);
      const a = keep.filter(m => m.role === 'assistant').length;
      const u = keep.filter(m => m.role === 'user').length;
      const compacted = currentSession.messages.slice(0, systemIdx + 1);
      compacted.push({ role: 'system', content: `[Previous: ${a} assistant, ${u} user turns. Compacted at ${new Date().toISOString()}]` });
      currentSession.messages = compacted;
      console.log(`\x1b[90mCompacted to ${compacted.length} messages.\x1b[0m`);
      break;
    }
    case '/save':
      currentSession?.save();
      console.log('\x1b[32m✓\x1b[0m Saved.');
      break;
    case '/exit':
    case '/quit':
      currentSession?.save();
      console.log('\n\x1b[90mBye!\x1b[0m');
      exit(0);
    default:
      console.log(`\x1b[33m?\x1b[0m Unknown: ${cmd}. Type \x1b[36m/help\x1b[0m`);
  }
}

async function runAgent(messages) {
  let loopCount = 0;
  do {
    const instructions = loadProjectInstructions(process.cwd());
    const systemMsg = { role: 'system', content: getSystemPrompt(instructions) };
    const chatMessages = [systemMsg, ...messages];
    chatMessages.splice(1, 0, { role: 'system', content: `CWD: ${process.cwd()} | ${process.platform} ${process.arch}` });

    process.stdout.write('\n');

    const { content, reasoningContent, toolCalls, usage } = await chatWithTools(chatMessages, TOOLS_DEFINITION, (chunk) => {
      process.stdout.write(chunk);
    });

    if (content) {
      const last = messages[messages.length - 1];
      const msg = { role: 'assistant', content };
      if (reasoningContent) msg.reasoning_content = reasoningContent;
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
      process.stdout.write(`\x1b[90m--- ${tc.function.name} ---\x1b[0m\n`);
      messages.push(await executeToolCall(tc, approvalMode));
    }

    loopCount++;
    if (loopCount > 25) { console.warn('  \x1b[33m⚠ Too many loops. Ending.\x1b[0m'); break; }
    if (messages.filter(m => m.role === 'tool').length > 100) { console.warn('  \x1b[33m⚠ Too many tool calls.\x1b[0m'); break; }
  } while (true);
}

async function resumeSession() {
  if (!currentSession) return;
  process.chdir(currentSession.cwd);
  showDashboard();
  console.log(`\x1b[90m  Resumed ${currentSession.id} from ${new Date(currentSession.created).toLocaleString()}\x1b[0m\n`);

  while (true) {
    const text = await readLineRaw('\x1b[36m>\x1b[0m ');
    if (!text) continue;
    if (text.startsWith('/')) { await handleSlashCommand(text); continue; }
    currentSession.messages.push({ role: 'user', content: text });
    await runAgent(currentSession.messages);
    currentSession.save();
    showMiniStatus();
  }
}

async function pickSession(sessions, forkMode = false) {
  if (sessions.length === 0) { console.log('No sessions.'); return; }
  console.log('\n  \x1b[1mSessions:\x1b[0m\n');
  sessions.forEach((s, i) => {
    const d = new Date(s.updated).toLocaleString();
    const p = s.messages.find(m => m.role === 'user')?.content?.substring(0, 60) || '(empty)';
    console.log(`  \x1b[36m${i + 1}.\x1b[0m [\x1b[90m${s.id.substring(0, 8)}\x1b[0m] ${d} - ${p}`);
  });
  const a = await readLineRaw('\n  \x1b[1mSelect:\x1b[0m ');
  const idx = parseInt(a) - 1;
  if (idx >= 0 && idx < sessions.length) {
    if (forkMode) {
      const orig = sessions[idx];
      currentSession = new Session(null, orig.cwd);
      currentSession.messages = [...orig.messages, { role: 'system', content: '[Forked]' }];
      console.log(`\x1b[32m✓\x1b[0m Forked ${orig.id.substring(0, 8)} -> ${currentSession.id.substring(0, 8)}`);
    } else currentSession = sessions[idx];
    await resumeSession();
  }
}
