FROM node:22-alpine AS base

# Install openwork-orchestrator (pulls platform-specific binary via optionalDependencies)
RUN npm install -g openwork-orchestrator@latest

# Create workspace directory
RUN mkdir -p /workspace

EXPOSE 10000

# Default command — can be overridden by Pantheon provisioner
CMD ["openwork", "serve", "--workspace", "/workspace"]
