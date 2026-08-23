# ADR 0005: Archive and attachment defaults

Status: superseded by ADR 0009 (2026-08-22)

## Decision

Archive every guild channel/thread Bananasaurs can view and read history by default, with dashboard exclusions. Attachments under 10 MB are eligible by default, subject to owner-controlled type, storage, parsing, and channel policies. Retention is indefinite until the owner configures expiry.

## Consequences

Server context is comprehensive and available for later retrieval. Storage growth, sensitive-data exposure, attachment safety, Discord deletion behavior, backups, and public-release privacy require prominent controls, metrics, and documented policy.

