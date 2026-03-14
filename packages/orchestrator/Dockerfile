FROM node:22-alpine

# Install s6-overlay for process supervision
ARG S6_OVERLAY_VERSION=3.2.0.2
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp
RUN apk add --no-cache xz \
    && tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz \
    && rm /tmp/s6-overlay-*.tar.xz

# Install OpenCode CLI
RUN npm install -g @opencode-ai/cli@latest

# Create workspace directory
RUN mkdir -p /workspace

# Copy s6 service definition
COPY rootfs/ /

EXPOSE 10000

ENTRYPOINT ["/init"]
