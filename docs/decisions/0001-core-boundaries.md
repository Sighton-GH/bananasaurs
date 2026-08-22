# ADR 0001: Server-owned assistant core

Status: accepted

## Decision

The self-hosted server owns identity, instructions, authorization, conversation state, memory, archive, tools, reminders, routing, and audit. Discord and the dashboard are interface adapters. Model providers are replaceable inference services.

## Consequences

Provider switching does not erase identity or memory. Context disclosure can be controlled centrally. More application logic must be implemented locally, and provider-native threads cannot be relied on as canonical state.

