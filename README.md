# Codex CLI - ARM32 Lite

AI coding agent for **32-bit ARM** (phones, tablets, Raspberry Pi, routers) and **ARM64**. Works for free — no API key needed.

## Features

- **Free AI** — uses OpenCode Zen API (no key needed, $0)
- **Local models** — works with Ollama and LMStudio via `--oss`
- **Full tool access** — read, write, edit, bash, glob, grep, and more
- **Web UI** — browser-based chat interface (`codex web`)
- **MCP server** — connect from VS Code, Cursor, or any MCP client (`codex mcp-server`)
- **Session management** — resume, fork, save conversations
- **Diagnostics** — `codex doctor` checks everything

## Installation

### Prerequisites

- **Node.js 16+** (ARM32/ARM64)
- **npm** (comes with Node.js)
- **git**

### Install

```bash
# Clone
git clone https://github.com/tundefund0-gif/codex-arm32-lite.git
cd codex-arm32-lite

# Install dependencies
npm install

# Make codex available globally
npm link

# Run it
codex
```

### Termux (Android)

```bash
pkg update && pkg upgrade -y
pkg install nodejs git -y
curl -sSf https://raw.githubusercontent.com/tundefund0-gif/codex-arm32-lite/main/install-termux.sh | bash
```

Or manually:

```bash
pkg install nodejs git -y
git clone https://github.com/tundefund0-gif/codex-arm32-lite.git
cd codex-arm32-lite
npm install && npm link
codex
```

### Verify Installation

```bash
codex doctor
```

## Usage

### Interactive Session (default, free)

```bash
codex
```

Type your prompts, use `/help` for commands.

### Quick Prompts

```bash
codex "explain this codebase"
codex "fix the bug in src/index.js"
```

### Web UI

```bash
codex web          # http://localhost:5000
codex web 8080     # custom port
```

### MCP Server (IDE Integration)

Connect from VS Code, Cursor, or any MCP client:

```bash
codex mcp-server
```

Example MCP client config (VS Code `settings.json`):

```json
{
  "mcp.servers": {
    "codex-arm32": {
      "command": "codex",
      "args": ["mcp-server"]
    }
  }
}
```

### Local Models (Ollama / LMStudio)

```bash
# Auto-detect local provider
codex --oss

# Specify provider
codex --local-provider ollama
codex --local-provider lmstudio

# With prompt
codex --oss "refactor this code"
```

### Non-Interactive Exec

```bash
codex exec "run all tests and report failures"
```

### Session Management

```bash
codex                     # Start new session
codex resume --last       # Continue last session
codex resume              # Pick from list
codex fork                # Fork a session
```

### Diagnostics

```bash
codex doctor
```

Checks: platform, config, provider, Ollama/LMStudio status, git/curl/ripgrep availability, token usage, session health.

## Models

| Model | How | Cost |
|---|---|---|
| `opencode/big-pickle` | OpenCode Zen API (default) | **$0** |
| `ollama/qwen2.5:0.5b` | Local Ollama | **$0** |
| `ollama/llama3.2:1b` | Local Ollama | **$0** |
| `lmstudio/local-model` | Local LMStudio | **$0** |
| `gpt-4o` / `gpt-4.1` | OpenAI API | Requires key |

Set model: `codex --model opencode/big-pickle` or `export CODEX_MODEL=opencode/big-pickle`

## Slash Commands

```
/help         Show help
/status       Session stats
/clear        Clear screen
/new          New conversation
/model <name> Switch model
/permissions  Change approval mode
/yolo         Toggle full access
/diff         Git diff
/cost         Token usage
/compact      Compact history
/save         Save session
/exit         Quit
```

## Flags

| Flag | Description |
|---|---|
| `-m, --model <name>` | Set model |
| `-C, --cd <path>` | Working directory |
| `--oss` | Use open-source provider (Ollama/LMStudio) |
| `--local-provider <name>` | Specify OSS provider (`ollama` or `lmstudio`) |
| `--yolo` | Skip all approvals |
| `-s, --sandbox <mode>` | Approval mode |
| `--add-dir <path>` | Extra writable directories |
| `--image <path>` | Attach image to prompt |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CODEX_MODEL` | `opencode/big-pickle` | Model selection |
| `CODEX_API_KEY` | — | OpenAI API key |
| `OPENCODE_API_KEY` | `public` | OpenCode Zen key |
| `CODEX_BASE_URL` | auto | Custom API endpoint |
| `CODEX_CONFIG_DIR` | `~/.codex` | Config directory |
| `CODEX_APPROVAL_MODE` | `auto` | Default approval mode |

## Project Structure

```
codex-arm32-lite/
  bin/codex.js        # Entry point
  src/
    index.js          # CLI commands, agent loop
    config.js         # Provider/model config
    openai.js         # OpenAI-compatible API client
    session.js        # Session persistence
    tools.js          # Tool definitions (read, write, bash, etc.)
    webui.js          # Web UI server
    mcp-server.js     # MCP stdio server
    doctor.js         # Diagnostics
    index.html        # Web UI frontend
```

## License

Apache-2.0
