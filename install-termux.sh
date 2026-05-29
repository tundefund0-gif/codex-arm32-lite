#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${CYAN}[STEP]${NC} $1"; }

REPO_URL="${1:-https://github.com/tundefund0-gif/codex-arm32.git}"
INSTALL_DIR="$HOME/codex-arm32"

check_arch() {
    local arch
    arch=$(uname -m)
    case "$arch" in
        armv7l|armv8l|arm) log_info "Detected 32-bit ARM: $arch ✓" ;;
        aarch64|arm64)
            log_warn "64-bit ARM detected. The original @openai/codex also works on this arch."
            log_warn "But this build will work fine too."
            ;;
        *) log_warn "Unknown arch: $arch. Trying anyway..." ;;
    esac
}

check_node() {
    if ! command -v node &>/dev/null; then
        log_info "Node.js not found. Installing via pkg..."
        pkg install -y nodejs
    fi
    log_info "Node: $(node --version)"
    log_info "npm: $(npm --version)"
}

install_codex() {
    log_step "Installing Codex CLI for ARM32..."
    
    if [ -d "$INSTALL_DIR" ]; then
        log_info "Updating existing installation..."
        cd "$INSTALL_DIR"
        git pull
    else
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi

    log_step "Installing npm dependencies..."
    npm install --no-optional

    log_step "Linking codex globally..."
    npm link

    echo ""
    log_info "Codex CLI installed successfully!"
    echo ""
    echo "  Quick start (FREE - no API key needed!):"
    echo "    ollama pull qwen2.5:0.5b           # Pull a small free model"
    echo "    codex --model ollama/qwen2.5:0.5b \"explain this\""
    echo ""
    echo "  Or with OpenAI API key:"
    echo "    codex auth sk-xxx..."
    echo "    codex"
    echo ""
    echo "  Usage:"
    echo "    codex 'fix the bugs in this code'"
    echo ""
}

show_requirements() {
    echo ""
    echo "============================================"
    echo "  Codex CLI - 32-bit ARM Termux Installer"
    echo "============================================"
    echo ""
    echo "  Requirements:"
    echo "    - Termux from F-Droid (NOT Play Store)"
    echo "    - At least 50MB free space"
    echo "    - Internet connection"
    echo ""
}

show_requirements
check_arch
check_node
install_codex
