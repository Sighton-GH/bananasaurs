# 0070. The owner may reveal sealed account passwords

Date: 2026-09-24
Status: Accepted (owner approved spec 2026-09-24)

## Context

Generated passwords are shown once on the success screen. If the owner loses
one, the only option is to set a new password. The owner decided (spec
decision O1) they may view other accounts' passwords from an encrypted copy.
Implements spec Part A section A4.

## Decision

- New nullable column `dashboard_accounts.password_sealed`: AES-256-GCM, the
  same construction as the sealed provider keys, with its own key derived
  from a new key file `account-password.key` (mode 0600, in the data
  directory, not in the database and not in backups).
  `ACCOUNT_PASSWORD_SECRET_KEY` in `.env` overrides the file.
- It is written whenever a password is set through the dashboard or CLI for a
  non-owner account. Owner passwords are never sealed.
- `POST /api/accounts/:username/reveal-password` is allowed only for an owner
  session, requires a fresh re-authentication (ADR 0029's reauth), returns the
  password once, and writes an audit row "owner revealed the password of
  `sam`". The password itself is never logged.
- Existing accounts have no sealed copy. Their edit page says "Set a new
  password to be able to reveal it later."
- Restoring a backup on a host without the key file: reveal says "Not
  available on this install — set a new password." Sign-in is unaffected,
  because the Argon2id hash stays the authority.
- `doctor` gains a line: vault key present, permissions correct, and the count
  of revealable accounts.

## Consequences

The owner can recover a member's password without resetting it, at the cost
of a second sealed secret to keep. Every reveal is audited without the
password, and the key file must move with backups by hand or reveal stops
working until passwords are reset.
