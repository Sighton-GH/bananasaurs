# P5 unit 7c deviations and notes

Base `d318fb29`, branch `oc/p5-u7c`. Pages: overview, overview-pulse, jobs, audit, backups, accounts,
account-new, docs, login, not-found, panels list. No file outside these pages, their tests and this note was
edited. No request, method, URL, body, CSRF or reauth path changed.

## Source choices

- **Wrappers.** None needed. No page was moved or split, so no original-path wrapper exists and no
  move-only commit was made (the plan's move-then-sweep rule applies to splits).
- **Panels list.** Not named in the 7c plan text; included per the unit brief. Title and caption are now
  "Role panels" (was "Self-granted roles"). The builder (`panel-builder.tsx`) is untouched. No row links:
  the page keeps its in-page selection and there is no panel detail route, so none was invented.
- **Jobs / audit / backups / accounts / panels.** Times are relative with the absolute time in `title`.
  Status text became `Badge`s. Detail cards use `DescriptionList`. Legacy classes on touched lines moved to
  tokens (`text-danger`, `rounded-sm`, `text-sm`).
- **Audit.** Added a filtered-empty state ("No audit rows match these filters" + Clear filters, which
  resets draft and applied filters and refetches the default request).
- **Accounts.** Locked-until stays an absolute time (a future lockout needs the exact clock time). Empty
  roster is now an `EmptyState`.
- **Account-new.** Password choice uses the kit `RadioGroup` (legend "How the password is set"). The
  PrintOnce flow, the POST body and the permission bindings are unchanged.
- **Login.** The guild choice uses the kit `Select` (was a raw `<select>`). Heading uses `text-title`.
  Backdrop, brand, ThemeToggle, Attribution, autofocus, autocomplete and the exact fetch bodies are
  unchanged. The Radix select keeps a hidden native `<select aria-hidden>` for form semantics; the test
  accounts for it.
- **Overview pulse.** A failed or denied check no longer lets the card read "Nothing needs attention".
  A 403 says "You do not have permission to check X"; any failed check adds an "incomplete" notice. The
  one `/api/health` fetch and the per-capability loads are unchanged. Denied is never shown as zero.
- **Docs.** Kept `<a href="#topic">` anchors: the kit `Link` refuses non-path hrefs. See-also links use
  the kit `Link`. START HERE group left as is.
- **Not found.** Uses the kit `NotFound`. H1 stays "Not found" (Shell test asserts it).
- **Em dashes** in the overview purpose line were replaced with a full stop.

## Cross-unit item for the lead (not in this branch)

`app/Shell.test.tsx` row `['/panels', 'Self-granted roles', 'Role panels']` now fails because the page H1
is "Role panels". Proposed one-line patch: `P5-7c-shell-test.patch` (change the second element to
`'Role panels'`). Shell.test is outside this unit's ownership.

## Red-first record

Red confirmed before the fix (test run showed failure): jobs (relative time, detail badge), audit (relative
time, filtered empty), backups (relative time, badge), account-new (RadioGroup), login (Select, heading
tokens), panels (title, badges, DescriptionList), overview-pulse (denied not clear, relative time, kit
links), overview (kit links). Tests added that were already green on arrival (they pin existing behaviour,
not red-proved): empty/500/403 states for jobs, audit, backups, panels, overview; audit invalid-duration
keeps input. Accounts' new tests and docs/not-found tests were written alongside the change and not run
against the old code.

## Not verified

- No native pixel, 360/1440, light/dark, keyboard-focus or screen reader check was made. No screenshots.
- The Overview 180 CSS opener word-break was not reproduced or measured; nothing was changed for it.
- Sticky long-account reachability, system dialog, copy and PrintOnce on a real browser: not checked.
- Tab-draft preservation: none of these pages has tabs, so there is nothing to carry across tab switches.
- Login multi-guild and lockout bodies are covered by existing jsdom tests only.
