# PxyCrab-Centric Stack

## Summary

Refactor from worker-centric to agent-centric architecture. An **Agent** is a personalized AI assistant (name, system prompt, platform presence). A **Conversation** is a runtime instance on an Agent defining provider/model/workspace. PxyCrab manages per-conversation RunningBots.

## Key Changes

### Pantheon
- Rename `Agent` (API auth identities) to `ExternalAgent`
- New `Agent` model: owner_id, name, system_prompt, platform (nightshift/slack), nightshift_api_key, slack creds, status
- Extend `Conversation`: add agent_id, provider fields
- Extend `ChatMessage`: add delivered_to_nightshift, source fields
- New NightShift server API at `/api/nightshift` (register, heartbeat, inbox, messages)
- New Agent CRUD + fleet endpoint at `/api/agents/active`
- Conversations can route through NightShift (PxyCrab polls inbox, sends responses)

### PxyCrab
- `BotConfig` -> `AgentConfig` with conversations list
- Per-conversation RunningBots (keyed by conversation_id)
- Handler processes single conversation
- Cross-platform: writes to Pantheon + Slack simultaneously
- Fleet endpoint changes from `/api/bots/active` to `/api/agents/active`

### Docker
- PxyCrab Dockerfile adds Node.js 22 + claude-code + opencode CLIs
- docker-compose removes Docker socket mount, adds pxycrab_data volume
