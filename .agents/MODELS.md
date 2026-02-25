# Team-of-Agents Model Routing

This file defines the canonical routing policy used by agent instructions.

## Core Principle

- Claude is the orchestrator and owns final implementation.
- Delegated models provide support outputs only.

## Routing Table

| Task Type | Primary | Fallback |
|---|---|---|
| research | kimi | zai |
| analysis | zai | kimi |
| creative | kimi | zai |
| translation | kimi | zai |
| summarization | minimax | kimi |
| long-context | minimax | kimi |
| fast | minimax | zai |
| cheap | minimax | zai |
| file-editing | codex | kimi |
| general | kimi | minimax |

## Delegation Output Contract

Each delegated result should include:

1. Recommended actions.
2. Key risks/assumptions.
3. Minimal patch advice.

## CLI Notes

- Gemini: use `--include-directories`, not `-w`.
- Kimi: ensure valid login before headless runs.
