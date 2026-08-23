# Owner decisions and answers

Updated 2026-08-22 after the plan review. Recommended defaults are included so planning and safe prototype work can continue.

## Answered

1. **Current dependencies:** Carl-bot is doing three things — logging edits and deletions to a log channel, reaction roles, and some automod. All three are replacement targets. Carl-bot is not vital and can be switched off at a moment's notice, which lowers cutover risk considerably.
2. **Release order:** logging and reaction roles first (Release 1), automod and moderation second (Release 2), the AI assistant third (Release 3). See `docs/08`.
3. **DM policy:** deterministic help/FAQ is allowed. AI is off in DMs unless explicitly authorized in the dashboard for a user and guild.
4. **Archive scope:** default-deny. The owner chooses which channels and forums Bananasaurs pulls information from (ADR 0009). Attachments under 10 MB are eligible in enabled channels, with per-channel `none`/`metadata`/`bytes` handling.
5. **Retention:** live messages indefinite until the owner changes it; deleted content 30 days unless pinned to an open case or explicitly preserved (ADR 0009).
6. **Distribution:** private during testing, with eventual public release.
7. **Isolation:** memory, context, archive, resources, permissions, instructions, and related state are server-specific.
8. **Automod testing:** global testing-mode toggle plus per-rule states. Testing logs proposed actions without punishment. No overlapping enforcement with Carl-bot.
9. **Permission model:** moderation rights depend on each server's actual users and roles, mapped by the owner. **Discord Administrator grants nothing** — other club members hold it (ADR 0012).
10. **Dashboard access:** owner-provisioned local accounts with a login the owner sets. Not Discord OAuth as the primary gate.
11. **Member access:** owner-only for now. A limited member-facing tier — search and questions within what the member can already read — comes after Release 3.
12. **Privacy surface:** `PRIVACY.md` is published, `/privacy` renders it with live settings, `/mydata` and `/forgetme` exist. Deliberately proportionate to a small private club server, and it references Discord's own Terms and Privacy Policy so members can see the bot is not an outlier.
13. **Public model:** the eventual public release is self-hosted, not a centrally hosted multi-tenant bot.
14. **Reference scale:** approximately 30 members, two dozen channels, inconsistent daily messages, on an older Linux Mint PC used for server development only — not a daily driver, so always-on and restore drills are both realistic.
15. **Discord history volume:** small. Backfill is cheap and bounded by the channel allowlist.
16. **Stack:** TypeScript, discord.js, SQLite, Drizzle, Fastify, React (ADR 0008).
17. **License:** Apache-2.0 (ADR 0011). YAGPDB may be adapted with attribution; Red-DiscordBot and Zeppelin may not be copied.
18. **Providers:** NVIDIA NIM free tier for development only; a paid API key for production; the Claude subscription builds the bot and never serves requests from it (ADR 0010).

## Still needed

1. ~~**Host profile**~~ — answered. i7-6700, 8 threads, 19 GiB RAM, 45 GB free, Mint 22.3, dedicated to server work. Recorded in `docs/15`, which relaxed the memory budget to ~1 GB and reopened local embeddings and a small local generation model as real options.
2. **Backup destination:** local second disk, NAS, or encrypted remote. Interim recommendation: local path first with `restic` or `borg`, plus a documented encrypted off-host target. The restore drill happens in Release 1, not at the end.
3. **Monthly AI spend ceiling:** a number, which becomes a config value that fails closed.
4. **Release 1 configuration:** which panels, which roles, which log events, which destinations. Blank slate — nothing is imported from Carl-bot. Sheet at `docs/RELEASE1_CONFIG.md`. Does not block the first coding session, but must exist before cutover.
5. **Anti-nuke posture:** other members hold Discord Administrator. Decide whether Bananasaurs should detect and alert on privileged-account abuse (mass bans, mass role deletion, mass channel deletion) or stay out of it. Detection and alerting is tractable; prevention is not, and should not be promised.
