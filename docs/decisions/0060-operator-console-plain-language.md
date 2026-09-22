# 0060 - Plain-language operator console

## Status

Accepted

## Decision

The operator console uses server, operator, preview mode, and plain action names consistently. The primary navigation begins with Overview and groups implementation-facing tools under Advanced / System. Ordinary forms select Discord objects by name; raw identifiers and configuration data sit behind advanced disclosure. Destructive and enabling controls state their member-visible or Discord-visible result.

## Consequences

First-time operators can follow the console without knowing Bananasaurs internals. Internal API and database names remain unchanged. Technical detail remains available where troubleshooting requires it, but it is not the default UI.
