# 0029 — Dashboard sessions: lifetime, CSRF, lockout, and re-authentication

Status: accepted
Date: 2026-08-30
Implements: ADR 0012's "bounded lifetime and server-side revocation", `docs/19`
§6.10. Depends on ADR 0028 for what a session's actor is authorized to do.

## Context

`docs/19` §6.10 settles the big choice — sessions are DB-backed rather than
stateless-signed, "specifically so revocation is immediate; a signed cookie you
cannot revoke is the wrong trade for a control plane with a kill switch on it".
The `dashboard_sessions` columns that exist — `created_at`, `expires_at`,
`revoked_at`, `reauth_at`, `ip` — are the ones to make policy about, and the
columns that do *not* exist rule some policies out.

## Decision

### The token and what is stored

The cookie carries 32 bytes from `crypto.randomBytes`, base64url. The database
stores **only `sha256(token)`**, in `session_id`. A plain SHA-256 is correct
here and Argon2id would be wrong: the input is 256 bits of uniform randomness,
so there is no dictionary to slow down, and a work factor on the hot path of
every request is a denial-of-service knob pointed at ourselves.

The consequence is the one that matters: a database backup, a diagnostics
bundle, or a `SELECT * FROM dashboard_sessions` yields nothing anyone can log in
with.

Cookie attributes: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` matching the
row's expiry. **`Secure` is deliberately not set.** The server binds
`127.0.0.1`, and both documented ways to reach it from elsewhere — `ssh -L` and
Tailscale — deliver it to the browser as `http://127.0.0.1:<port>`. A `Secure`
cookie would simply never be stored, and the failure mode is a login that
appears to succeed and then bounces back to the login page.

### Lifetime: absolute, twelve hours, no sliding renewal

`expires_at = created_at + 12h`, fixed at creation and never extended.

Sliding renewal is the usual default and is the wrong default here: it means a
browser tab left open on the kill-switch console stays authenticated forever.
The schema also settles it — there is no `last_seen_at` column, so an idle
timeout is not expressible, and the honest choice between "absolute only" and
"sliding only" is absolute.

### Re-authentication: five minutes, and only in the dangerous direction

`reauth_at` is set at login and refreshed by a successful re-authentication.
A destructive action requires `now - reauth_at <= 5 minutes`; otherwise the API
answers `401` with `reason: "reauth-required"` and the page asks for the
password again without ending the session.

What counts as destructive in Release 1:

- **Disabling** the kill switch.
- Changing an account's password, and deleting an account.

**Enabling the kill switch is deliberately not gated.** The control that stops
the bot must never be harder to reach than the control that starts it. An
operator hitting the switch is reacting to something already going wrong, and a
password prompt in that moment is a failure of the design, not a safeguard.
`undo.execute` is likewise not gated: undo reverses a batch, it does not create
one, and the same argument applies.

### CSRF: a token derived from the session token itself

Every state-changing request must carry `X-Bananasaurs-CSRF` equal to
`sha256("bananasaurs.csrf:" + rawSessionToken)`, which the server recomputes
from the cookie it just read.

- It needs **no column**, so it cannot drift from the session it belongs to, and
  no migration is required to add it.
- It needs **no server secret**, so it survives a restart exactly as long as the
  session does. A key held in memory would invalidate every live session's CSRF
  token on every daemon restart; a key in the environment would be one more
  secret to manage for a control that does not require one.
- It is not guessable from the CSRF token: SHA-256 is one-way, so a leaked CSRF
  token does not yield the session token.
- The attacker a CSRF token defends against cannot read an `HttpOnly` cookie and
  therefore cannot compute it. The dashboard obtains it from `GET /api/session`,
  whose body a cross-origin page cannot read, because no CORS headers are ever
  sent.

`SameSite=Lax` is the second layer, and an `Origin` check the third: when the
request carries `Origin`, its host must equal the request's `Host`. That is an
equality check rather than an allowlist, so it works for `127.0.0.1`,
`localhost`, and a Tailscale name without configuration.

### Lockout: five attempts, fifteen minutes, uniform answers

`failed_attempts` increments on a wrong password and resets to zero on success.
At five, `locked_until = now + 15 minutes` and the account is refused without
the password being checked at all.

The failure response is the **same** for an unknown username, a wrong password,
a disabled account, and a locked one. When the username does not exist, the
server still runs one Argon2id verification against a fixed dummy hash, so the
response time does not answer "does this account exist" either. On a
loopback-bound control plane that is cheap insurance rather than a pressing
threat, and the cost is four lines.

### Read-only mode refuses login, and says so

Creating a session is a write, and so is recording a failed attempt. Under
`BANANASAURS_READONLY`, `writeInstance` throws `ReadonlyError` and the API
answers **`503`** with a body naming the environment variable.

`503` rather than `403`: the request was well-formed and the caller was not
denied permission — the server is in a mode where it cannot do it. `403` would
send an operator looking for a missing grant.

Allowing login in read-only mode by keeping sessions in memory was considered
and rejected. It would mean a second session store with different revocation and
different durability, and — worse — lockout with nowhere to count, so the one
control standing between a network-reachable password form and unlimited guesses
would be silently absent in exactly the mode nobody tests. Read-only mode's
inspection path is the operator CLI, which is already read-only-clean.

**The bootstrap token generator must not repeat slice 13d's failure.** It writes
at startup, so under `BANANASAURS_READONLY` it skips issuance and logs a warning
instead of throwing and taking the daemon down.

## Consequences

- Expired and revoked rows accumulate; the lookup filters them and nothing
  prunes them. That is correct for Release 1 — the trail of when someone was
  logged in is worth more than the rows cost — and a retention pass belongs with
  the rest of retention, not here.
- Twelve hours means the owner logs in roughly once a working day. That is the
  intended amount of friction for a console with a kill switch on it.
- The CSRF derivation is load-bearing and unusual enough to be worth a comment
  at its definition, not only here.
