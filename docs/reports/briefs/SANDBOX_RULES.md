# Sandbox rules — read this before running any command

Every brief in this directory includes this file by reference. It exists because
the same handful of command shapes got refused repeatedly across a dozen
dispatches, and each refusal cost a turn and a human approval.

## Never read secrets, and never ask to

`.env`, `data/**` and `backups/**` are deny-listed in `.claude/settings.json`.
`data/` holds the SQLite database with real member message content.

**A refusal on these grounds is the rule working, not an obstacle.** Do not ask
the human to approve one, do not retry it, and do not look for another route to
the same bytes. If something genuinely cannot be checked without configuration,
write "not verifiable in this environment" in your report and move on.

Nothing in this project's work needs a credential. `npm run test` runs with no
network and no live Discord **by design**.

## The approver verifies statically, so write verifiable commands

It cannot run a command to find out what it touches, so anything whose file
targets are computed, implicit, or hidden behind a wrapper is refused on the
worst-case reading. Left column is what gets refused; right is what to write.

| Refused | Write instead |
| --- | --- |
| `rg -n "pat"` — no path | `rg -n "pat" packages/core/src` — **always** name a file or directory |
| `sed -n '1,50p' f \| rg "pat"` | `rg -n "pat" f` — drop the pipe, rg reads files directly |
| `while read -r f; do rg "pat" "$f"; done` | `rg -n "pat" dir1 dir2` — never a loop variable as a path |
| `git diff A B -- . ':!docs'` | `git diff A B -- packages/core/src apps/daemon/src` — never a bare `.` |
| `python3 - <<'PY' … PY \|\| cmd` | One command per call; a heredoc followed by anything else is unverifiable |
| `cd x && …` | Absolute paths — `cd` in a compound command cannot be verified as staying in the worktree |
| `rm -rf <dir>` | Leave scratch files where they are |

`python3 -c` and `node -e` are arbitrary code execution and **will** prompt.
That is correct; write a file and run it, and expect the prompt anyway.

## Check gates by exit code, never through a pipe

```
npm run typecheck >/dev/null 2>&1; echo "typecheck: $?"
npm run lint      >/dev/null 2>&1; echo "lint: $?"
npm run test      >/dev/null 2>&1; echo "test: $?"
```

**Do not write `npm run lint 2>&1 | tail -2 && …`.** The pipeline's exit status
is `tail`'s, which is 0 whatever npm did, so `&&` chains onward past a failure
and a truncated tail reads as a pass. This let a red lint gate ship for several
commits — ledger finding E-5.

Prefer `npm run lint:fix` over calling `prettier` directly; it is already
permitted and does the same job.

## Two more facts about this machine

- **`grep` returns false negatives here.** Use `rg` with a path, or
  `awk '/pattern/{print FILENAME": "FNR": "$0}'`. A `grep` that finds nothing is
  not evidence.
- **`jq` is not installed.** An empty result from it is a missing binary, not an
  empty set.

## One disallowed segment prompts the whole line

`cp a b && sed -i … && rg …` drags three permitted commands into one approval.
Split compound commands so only the genuinely deliberate step asks.
