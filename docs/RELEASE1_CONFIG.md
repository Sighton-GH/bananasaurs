# Release 1 configuration sheet

**Blank slate.** Nothing is imported from Carl-bot. You are designing the setup you want, not reconstructing the old one.

This is the spec Claude Code builds against. It does not need to be complete before coding starts — the schema and the panel engine are the same whether you have two panels or ten — but it needs to exist before cutover, and filling it in early makes the design concrete.

One thing worth knowing before you plan: **members keep the roles they already have.** Roles live on Discord, not in Carl-bot. Turning Carl-bot off strips nothing. New panels only affect how people change roles from that point on, so there is no migration to get wrong.

---

## 1. Role panels

Release 1 builds **both kinds**:

- **Adopted panel** — you post a message, then tell Bananasaurs its message ID and an emoji-to-role mapping. It seeds the reactions and watches them. Exactly how Carl-bot works. The bot cannot edit your message or add buttons to it.
- **Managed panel** — Bananasaurs posts the message and attaches buttons or a select menu. It can edit the text later and reply privately when someone clicks ("You now have @3D Printing").

Use adopted panels where you want control of the wording, managed panels where you want buttons and confirmations.

### Panel 1

- **Kind:** adopted (your message) / managed (bot posts it)
- **Channel it goes in:** ______________________
- **Message ID** (adopted panels only — Developer Mode on, right-click the message → Copy Message ID): ______________________
- **Message text / embed** (managed panels only — for adopted panels you write it yourself):

  ```
  
  ```

- **Style:** reactions (adopted panels) / buttons (up to ~25 roles, 5 per row) / select menu (longer lists, allows multi-select)
- **Roles offered:**

  | Emoji / button label | Role | Notes |
  |---|---|---|
  | | | |
  | | | |
  | | | |

- **Behaviour:** toggle (click to add, click again to remove) / add-only / single-choice (picking one clears the others)
- **Limits:** max roles a member can hold from this panel, required role to use it, blocked roles: ______________________

*(Copy this block per panel.)*

### Roles that must exist first

List the Discord roles these panels hand out. Create them before the bot runs, and make sure the Bananasaurs role sits **above** all of them in Server Settings → Roles.

- ______________________
- ______________________
- ______________________

---

## 2. Logging

Where should events go, and which do you actually want? Fewer is better — a log channel nobody reads is noise, and message-content logging is the part members are most likely to have feelings about.

| Event | Want it? | Destination channel |
|---|---|---|
| Message edited | | |
| Message deleted | | |
| Bulk message delete | | |
| Member joined | | |
| Member left | | |
| Member banned / unbanned | | |
| Nickname changed | | |
| Roles changed | | |
| Channel created / deleted / updated | | |
| Role created / deleted / updated | | |
| Voice join / leave / move | | |
| Invite created / used | | |

- **Channels to exclude from logging entirely:** ______________________
- **Should deleted-message logs include the original content, or just "a message was deleted"?** ______________________

That last question is the one worth thinking about. Including content is more useful for moderation and more intrusive for members. Whichever you choose, it goes in `PRIVACY.md`.

---

## 3. Automod — later, and maybe never

Release 2, and only after checking whether Discord's own native AutoMod covers it. Native AutoMod is free, built in, and blocks content *before* it posts rather than deleting after. For keyword lists, spam, mention spam, and regex it is strictly better than anything a bot can do.

Since you are starting fresh, set up native AutoMod directly (Server Settings → AutoMod) and see whether anything is left over. If nothing is, Release 2 shrinks to moderation commands and cases, and the rule engine never gets built.

Leftover rules native AutoMod cannot express:

- ______________________

---

## 4. Cutover tracking

| Module | Ready | Cutover date | Notes |
|---|---|---|---|
| Role panels | | | Carl-bot's role module off |
| Logging | | | Carl-bot's logging off |
| Native AutoMod | | | Configured directly in Discord |

No overlap risk on any of these. Panels and logging can run alongside Carl-bot indefinitely — worst case is a duplicate log line — so switch when you are satisfied, not on a schedule.
