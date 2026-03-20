# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    jq \
    pandoc \
    poppler-utils \
    weasyprint \
    ripgrep \
    fd-find \
    direnv \
    hyperfine \
    pipx \
    python3-venv \
    unzip \
    && ln -s /usr/bin/fdfind /usr/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Install uv (fast Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Install DuckDB CLI
RUN curl -fsSL "https://github.com/duckdb/duckdb/releases/latest/download/duckdb_cli-linux-amd64.zip" \
    -o /tmp/duckdb.zip && unzip /tmp/duckdb.zip -d /usr/local/bin/ && rm /tmp/duckdb.zip

# Install just (command runner)
RUN curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to /usr/local/bin

# Install Rust CLI tools from GitHub releases
RUN set -eux; \
    # xh (HTTP client)
    XH_VER=$(curl -s https://api.github.com/repos/ducaale/xh/releases/latest | grep '"tag_name"' | cut -d'"' -f4); \
    curl -fsSL "https://github.com/ducaale/xh/releases/download/${XH_VER}/xh-${XH_VER}-x86_64-unknown-linux-musl.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local/bin/ --wildcards '*/xh'; \
    # eza (modern ls)
    EZA_VER=$(curl -s https://api.github.com/repos/eza-community/eza/releases/latest | grep '"tag_name"' | cut -d'"' -f4); \
    curl -fsSL "https://github.com/eza-community/eza/releases/download/${EZA_VER}/eza_x86_64-unknown-linux-musl.tar.gz" \
    | tar xz -C /usr/local/bin/; \
    # sd (modern sed)
    SD_VER=$(curl -s https://api.github.com/repos/chmln/sd/releases/latest | grep '"tag_name"' | cut -d'"' -f4); \
    curl -fsSL "https://github.com/chmln/sd/releases/download/${SD_VER}/sd-${SD_VER}-x86_64-unknown-linux-musl.tar.gz" \
    | tar xz -C /usr/local/bin/; \
    # procs (modern ps)
    PROCS_VER=$(curl -s https://api.github.com/repos/dalance/procs/releases/latest | grep '"tag_name"' | cut -d'"' -f4); \
    curl -fsSL "https://github.com/dalance/procs/releases/download/${PROCS_VER}/procs-${PROCS_VER}-x86_64-linux.zip" \
    -o /tmp/procs.zip && unzip /tmp/procs.zip -d /usr/local/bin/ && rm /tmp/procs.zip

# Install semgrep via pipx (needs to run as root for global install)
RUN PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install semgrep

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, and Google Workspace CLI globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @googleworkspace/cli

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Configure git to use GITHUB_TOKEN for authentication when available
RUN printf '#!/bin/sh\nif [ -n "$GITHUB_TOKEN" ]; then echo "protocol=https\nhost=github.com\nusername=x-access-token\npassword=$GITHUB_TOKEN"; fi\n' > /usr/local/bin/git-credential-env && chmod +x /usr/local/bin/git-credential-env

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\nif [ -n "$GITHUB_TOKEN" ]; then\n  git config --global credential.helper /usr/local/bin/git-credential-env\n  git config --global user.name "Sven"\n  git config --global user.email "sven@nanoclaw"\nfi\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
