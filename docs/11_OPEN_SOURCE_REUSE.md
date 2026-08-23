# Open-source and source-available reuse assessment

Verified against the linked upstream repositories on 2026-08-18. Recheck the exact commit and license before copying code.

## Strong references

### YAGPDB

- Repository: https://github.com/botlabs-gg/yagpdb
- License: MIT at the time of review.
- Relevant scope: automod, moderation, logs, autoroles, role commands, reminders, tickets, verification, feeds, and a control panel.
- Use: best broad feature and data-flow reference; permissive code reuse is possible with attribution/license compliance.
- Caveat: it is a mature Go system using PostgreSQL and Redis with multiple components. Forking or transplanting large modules may import more operational complexity than this single-server project needs.

### Red-DiscordBot

- Repository: https://github.com/Cog-Creators/Red-DiscordBot
- License: GPL-3.0 at the time of review.
- Relevant scope: modular self-hosted bot, moderation, mod logs, filtering, cleanup, self-roles, custom commands, permissions, and a large plugin ecosystem.
- Use: excellent behavior, plugin-boundary, command, and test reference.
- Caveat: copying or deriving code brings GPL obligations. Do not copy Red code unless the project’s licensing/distribution decision deliberately accepts that consequence.

### Zeppelin

- Repository: https://github.com/ZeppelinBot/Zeppelin
- License: Elastic License 2.0 at the time of review; source-available, not OSI open source.
- Relevant scope: large-server automod, cases/notes, logs, granular overrides, role tools, slowmode, starboard, and dashboard configuration.
- Use: strong architectural and UX reference, especially for rule overrides and cases.
- Caveat: ELv2 restricts providing substantial functionality as a hosted/managed service and imposes notice conditions. Prefer studying behavior and independently implementing it unless a deliberate license review approves code reuse.

## Libraries rather than bot code

Use a maintained Discord library such as discord.js or discord.py instead of implementing Gateway and REST behavior from scratch. The final choice should follow the selected language and the project’s needs, not the desire to match an upstream bot’s stack.

## Recommended reuse policy

1. Choose Bananasaurs’ own license before copying third-party implementation code.
2. Record upstream URL, commit, file, license, modifications, and notices in a provenance ledger.
3. Prefer concepts, test cases, and clean-room reimplementation when upstream architecture is a poor fit.
4. Prefer permissive modules with narrow dependencies. Never paste code whose license is missing or unclear.
5. Run dependency, security, and maintenance checks; popularity is not a security review.
6. Do not copy Carl-bot or Dyno proprietary code or scrape private behavior. Their public documentation can define feature expectations.

## Recommendation

Do not fork an entire existing bot yet. Build the Bananasaurs core around its AI/context requirements and deterministic module boundary. Use YAGPDB as the first detailed parity reference, Red for modular UX ideas without copying unless GPL is accepted, and Zeppelin for moderation/rule design patterns subject to its source-available license.

