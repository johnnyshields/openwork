# Build PxyCrab agent
FROM golang:1.24-bookworm AS builder

# Install bun for building the OpenCode helper binary
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# Build embedded OpenCode helper (required by bot/opencode_plugins.go)
RUN mkdir -p bot/embedded && \
    bun build ./helper/opencode-helper.ts --compile --outfile bot/embedded/pxycrab-opencode-helper

RUN CGO_ENABLED=1 GOOS=linux go build -tags fts5 -o /pxycrab ./cmd/pxycrab

# Workspace runtime
FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git sudo libgomp1 && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js 22 for Claude Code CLI
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code globally (as root, before switching user)
RUN npm install -g @anthropic-ai/claude-code

# Non-root user (Claude CLI blocks --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash workspace && \
    echo 'workspace ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/workspace
USER workspace

COPY --from=builder /pxycrab /usr/local/bin/pxycrab

WORKDIR /workspace

# Runtime env vars:
#   PXYCRAB_FLEET_PANTHEON_URL   — Pantheon base URL for fleet registration
#   PXYCRAB_FLEET_PANTHEON_API_KEY — API key for Pantheon authentication
ENTRYPOINT ["pxycrab", "--fleet"]
