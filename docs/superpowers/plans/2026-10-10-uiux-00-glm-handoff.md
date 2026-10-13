# UI/UX overhaul — implementer handoff (read this first)

You are implementing the UI/UX overhaul of Bananasaurs, a self-hosted Discord bot and its operator
dashboard, from five phase plans. You work on a remote workspace with no Discord token and no access to
the production machine. You hand back **patch files**; the owner and a reviewer apply, check and merge
them.

## 1. Read, in this order

1. `CLAUDE.md`: the project rules. The nine **hard rules** are absolute. Two matter most here:
   - **Hard rule 1:** AI is never in the enforcement path.
   - **Hard rule 2:** every query and repository function takes a guild scope.
2. `docs/superpowers/specs/2026-10-10-ui-ux-overhaul-design.md`: what is being built and why.
3. `docs/28_UI_UX_GUIDELINES.md`: the rulebook every Discord post and dashboard page follows.
4. `docs/decisions/0140-discord-cards-components-v2.md`, `0141-moderator-card-actions-and-error-catalogue.md`
   and `0142-dashboard-light-first-theme-fonts-icons.md`: the decisions behind the plans. The ADRs win over
   the spec where they differ.
5. `docs/design/ui-mockups.html`: open it in a browser. It shows what every card and page should look
   like.
6. The phase plan you are on.

## 2. Phase order

Each phase builds on the one before. Do them in order, each on its own branch cut from the previous
phase's branch.

| Phase | Plan | Branch |
| --- | --- | --- |
| P1 | `2026-10-10-uiux-p1-task-cards.md` | `uiux/p1-task-cards` from this branch |
| P2 | `2026-10-10-uiux-p2-logs-moderation-cards.md` | `uiux/p2-logs-moderation` from P1 |
| P3 | `2026-10-10-uiux-p3-dashboard-foundations.md` | `uiux/p3-dashboard-foundations` from P2 |
| P4 | `2026-10-10-uiux-p4-dashboard-shell.md` | `uiux/p4-dashboard-shell` from P3 |
| P5 | `2026-10-10-uiux-p5-dashboard-page-sweep.md` | `uiux/p5-page-sweep` from P4 |

P3 does not depend on P1 or P2 in code. If the owner asks for dashboard work first, branch P3 from this
branch instead.

## 3. Setup

```bash
node --version          # must be v22.x
npm ci
npm run typecheck
npm run lint
npm run test
```

All three gates must pass **before** you change anything. If they don't, stop and report it; don't start
the phase on a red baseline.

## 4. How to work

- **One task at a time, in the plan's order.** Each task lists the files, the interfaces it consumes and
  produces, and numbered steps. Follow the steps: write the failing test, watch it fail, implement, watch
  it pass, commit.
- **Run a single test file** with `npx vitest run <path/to/file.test.ts>`. Run the **full gates** at the
  end of every task:

  ```bash
  npm run typecheck
  npm run lint
  npm run test
  ```

  Run each command on its own and read its whole output. Do not pipe a gate through `tail`, `head` or
  `grep`. A task is not done until all three pass.
- **Commit once per task**, message `P<phase> Task <n>: <what>`, for example
  `P1 Task 3: REST adapter sends files, flags and modals`. Do not squash.
- **Schema changes:** edit `packages/storage/src/schema.ts`, then run
  `npm run db:generate -- --name <snake_case_name>`. This generates the SQL and snapshot under `drizzle/`
  and runs `scripts/strictify.mjs`, which makes new tables STRICT. Never hand-edit an existing migration.
  Never run `npm run db:migrate` against anything but a test database; tests migrate their own in-memory
  databases.
- **Formatting:** run `npx prettier --write <files you changed>` before committing. `npm run lint` checks
  Prettier.
- **Searching:** give `rg` or `grep` an explicit directory (`rg -n 'thing' packages/core/src`), never a
  bare `.`.

## 5. Rules you must not break

- **No live Discord.** Do not create a bot token, a `.env`, or anything that talks to Discord or the
  internet. Every test uses the fakes in `packages/testkit` or the REST harness in
  `packages/discord/src/rest/port.test.ts`.
- **No new dependencies** except the ones a plan names, in the version it names. P3 names three; nothing
  else does.
- **`packages/core` must not import `discord.js`**, a database, or `@bananasaurs/storage` (ADR 0014).
  ESLint enforces this.
- **Guild scope.** Every new repository function takes `scope: GuildScope` first and filters with
  `scope.only(...)`, exactly like its neighbours.
- **Mentions.** Every message the bot sends sets `allowedMentions` explicitly, with `parse: []`, and lists
  the users and roles it means to ping. Text a member or operator typed is escaped with
  `escapeText` / `escapeInline` from the card kit.
- **Moderation stays deterministic.** Moderator buttons (P2) call the existing `/mod` code paths. No model
  is called anywhere in P1–P5.
- **Do not touch** files a task doesn't list, unless the typecheck forces it (a new union member, a new
  required method on an interface). If it does, make the smallest change that compiles and say so in the
  task's commit message.
- **Copy:** user-visible strings follow `docs/28_UI_UX_GUIDELINES.md` §2–§3. Plans give exact strings; use
  them verbatim.

## 6. When the plan and the code disagree

The plans were written against `main` at `950f78fe` (2026-10-10). If a file, function or line the plan
names is different:

1. Read the enclosing function or module, not just the line.
2. If the intent is still clear, make the equivalent change, and record it in
   `docs/superpowers/plans/notes/<phase>-deviations.md` as `Task N: plan said X, code had Y, did Z`.
3. If the intent is not clear, or the change would break a hard rule, **stop that task**. Write the
   question in the same notes file, skip to the next task that doesn't depend on it, and say so in your
   report.

Never weaken a test, delete a test, or add `// @ts-ignore`, `eslint-disable` or `as any` to get a gate
green.

## 7. Handing back

At the end of each phase:

```bash
mkdir -p patches/<phase>
git format-patch <base-branch>..HEAD -o patches/<phase>/
```

`<base-branch>` is the branch the phase was cut from. Then report, in this shape:

```
Phase: P1
Branch: uiux/p1-task-cards @ <short sha>
Base: <base branch> @ <short sha>
Tasks done: 1–14 (or list)
Tasks skipped: none (or: N — reason)
Gates: typecheck PASS, lint PASS, test PASS (<N> tests)
Migrations added: drizzle/01xx_<name>.sql (or none)
New dependencies: none (or list with versions)
Deviations: see docs/superpowers/plans/notes/P1-deviations.md (or none)
Open questions: (list, or none)
```

Do not claim a gate passed unless you ran it and saw it pass in this session.
