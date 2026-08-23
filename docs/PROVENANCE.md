# Provenance ledger

Required by ADR 0011. Every piece of third-party code adapted into Bananasaurs is recorded here before the commit that introduces it.

Bananasaurs is Apache-2.0. That constrains what may be copied:

| Upstream | License | Rule |
|---|---|---|
| YAGPDB | MIT | May be adapted. Record it here and preserve the MIT notice. |
| Red-DiscordBot | GPL-3.0 | **Do not copy code.** Study behaviour and write original implementations. |
| Zeppelin | Elastic License 2.0 | **Do not copy code.** Source-available, not open source. Design reference only. |
| Carl-bot, Dyno | Proprietary | Public documentation defines feature expectations. No reverse engineering. |
| Unclear or missing license | — | Do not copy. |

Ordinary npm dependencies are **not** recorded here — `package.json` and the lockfile are the record for those. This ledger is for source code adapted into our own files, where the origin would otherwise be invisible.

Reading a codebase to understand how it behaves is not adaptation and needs no entry. Copying a function, a class, an algorithm with distinctive structure, a regex, or a schema does.

---

## Entries

None yet. No third-party source code has been adapted into this repository.

When the first one lands, use this shape:

```
### <short description of what was adapted>

- **Upstream:** <project name> — <repository URL>
- **Commit:** <full SHA read at the time of copying>
- **Source file:** <path within the upstream repository>
- **License:** <SPDX identifier, as stated in that repository at that commit>
- **Our file:** <path within this repository>
- **Modifications:** <what changed and why>
- **Notice:** <where the upstream copyright notice is preserved>
- **Date:** <YYYY-MM-DD>
```
