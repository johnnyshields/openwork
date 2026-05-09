# OpenWork — Claude Code Instructions

## Pantheon Integration

All Pantheon-related code modifications must be bracketed with comment markers:

```ts
// BEGIN-PANTHEON-OVERRIDE — <brief reason for this override>
... pantheon-specific code ...
// END-PANTHEON-OVERRIDE
```

This convention applies to every file touched for Pantheon integration. Include a brief reason so reviewers understand the purpose without reading the full plan.
