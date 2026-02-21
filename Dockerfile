FROM oven/bun:1 AS base

# System deps: git for repo management, ssh for private repos
RUN apt-get update && \
    apt-get install -y --no-install-recommends git openssh-client && \
    rm -rf /var/lib/apt/lists/*

# Claude CLI (installed via npm since bun global install has quirks)
RUN bunx --bun npm i -g @anthropic-ai/claude-code

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY bin/ bin/
COPY src/ src/
COPY tsconfig.json ./
COPY config.example.json .env.example ./

# Non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
# Default UID/GID 1000 matches most host users; override with --build-arg
ARG UID=1000
ARG GID=1000
RUN groupadd -g $GID ove 2>/dev/null || true && \
    useradd -m -s /bin/bash -u $UID -g $GID ove 2>/dev/null || true && \
    mkdir -p repos && \
    chown -R $UID:$GID /app
USER $UID

# Git safe.directory for mounted volumes
RUN git config --global --add safe.directory '*'

ENTRYPOINT ["bun", "run", "bin/ove.ts"]
CMD ["start"]
