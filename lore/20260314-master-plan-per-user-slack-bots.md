# Master Plan: Per-User Slack Bots + Multi-Bot PxyCrab + Full Stack

**Date:** 2026-03-14

## Overview

Every Pantheon user gets their own Slack bot (auto-provisioned via Slack App Manifest API). Each bot has isolated memory, sessions, and worker routing. PxyCrab runs as a single instance managing all bots (fleet mode). OpenCode workers are remote Docker containers.

## 4 Phases

1. **Pantheon** — SlackBot model, Manifest API client, bot provisioning API, admin UI
2. **PxyCrab** — Fleet manager, per-bot isolation (memory/sessions), Pantheon API polling
3. **PxyCrab** — OpenCode HTTP provider (remote workers instead of local CLI)
4. **Docker Compose** — Full stack: Pantheon + PxyCrab + n8n + MongoDB + Caddy

## Architecture

```
Pantheon :8080 ── auth, API, admin UI, bot provisioning, workers, conversations
PxyCrab         ── fleet of Slack bots (one Socket Mode conn per bot)
n8n :5678       ── workflow automation (webhooks, schedules)
Caddy           ── reverse proxy, TLS, path routing
N× OpenCode     ── per-user worker containers
```
