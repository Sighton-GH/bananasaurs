# ADR 0006: Self-hosted Linux runtime for consumer hardware

Status: accepted

## Decision

Release Bananasaurs as a self-hosted Linux application, with Linux Mint and comparable Debian/Ubuntu-family systems as first-class targets. Use a lightweight modular-monolith baseline with local persistence and no required Redis, broker, vector service, cluster, or local generation model. Offer native/systemd and minimal container deployment paths.

## Consequences

Operators retain data/control and older consumer PCs remain viable. Resource use, migrations, disk growth, backup, and upgrade behavior must be measured and documented. Optional scale-out infrastructure may be added later but cannot shape the initial product unnecessarily.

