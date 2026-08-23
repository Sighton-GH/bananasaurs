# ADR 0014: How package boundaries are actually enforced

Status: accepted (2026-08-23)

Supersedes the enforcement claim in `docs/19_RELEASE_0_1_PLAN.md` §1, which is wrong.

## Context

`docs/19` §1 states:

> Boundaries are enforced mechanically, not by convention: `core/package.json` lists neither `discord.js` nor `better-sqlite3`, so importing them fails typecheck, and `dependency-cruiser` runs in `npm run lint` with the layering rules encoded.

WP1 shipped without `dependency-cruiser` on the reasoning that the workspace manifests were the stronger of the two mechanisms and the lint rule was redundant. Owner review accepted skipping it under the protocol but flagged the gap it leaves: manifests cannot express *"only `core/effects` may reach the Discord REST port"*, which §5 of the plan lists as the fifth and outermost layer of the permission model. That gap opens in WP5, when `http` and `cli` exist.

**Measurement first, because the premise turned out to be false.** Two probes against this repository:

```
packages/core/src/boundary-probe.ts:
  import Database from 'better-sqlite3';        // NOT in core/package.json
  npx tsc -p packages/core/tsconfig.json        -> exit 0

packages/testkit/src/boundary-probe.ts:
  import { openTestDatabase } from '@bananasaurs/storage';   // NOT in testkit deps
  npx tsc -p packages/testkit/tsconfig.json     -> exit 0

node_modules/@bananasaurs/:
  core -> ../../packages/core        storage -> ../../packages/storage
  daemon -> ../../apps/daemon        testkit -> ../../packages/testkit
```

npm workspaces symlinks every workspace package into the root `node_modules`, and hoists external dependencies there too. Both Node and TypeScript resolve through the root. **A package manifest that omits a dependency does not prevent importing it; it prevents nothing at all.** Neither the plan's claim nor WP1's reasoning survives.

So the choice is not "manifests versus a lint rule". There is currently no enforcement of any kind.

## Decision

### 1. Not a package split

A separate package for the REST port cannot work. `package.json` `exports` controls which subpaths are *importable*, uniformly, by everyone. It has no notion of *who is importing*. There is no arrangement of packages under npm workspaces in which `core/effects` can reach a module and `http` cannot.

### 2. Not `dependency-cruiser`

It would do the job. It is also a new devDependency, and `docs/20` lists adding a dependency beyond ADR 0008 as a stop-and-ask. It is not worth spending that stop here, because a mechanism already present does the same work for the rules we actually have.

### 3. ESLint flat config, per-directory `no-restricted-imports`

Every boundary rule in the plan has the form *"code under directory X may not import module Y"*. ESLint flat config expresses exactly that with a `files:` block, and `npm run lint` already runs it.

```js
{
  files: ['packages/core/**/*.ts'],
  ignores: ['packages/core/src/effects/**'],
  rules: { 'no-restricted-imports': ['error', { patterns: [...] }] },
}
```

Rules encoded in `eslint.config.js`, each with the boundary justification from `docs/19` §1 as its message:

| Directory | May not import | Why |
|---|---|---|
| `packages/core/**` | `discord.js`, `better-sqlite3`, `drizzle-orm*`, `@bananasaurs/storage`, `@bananasaurs/discord` | `core` depends on port *interfaces* so every test runs with no network and no database handle |
| `packages/core/**` except `src/effects/**` | `@bananasaurs/discord/rest` | The fifth layer of the permission model: only the effect gateway can reach Discord |
| `packages/http/**`, `packages/cli/**`, `packages/dashboard/**`, `packages/discord/**` | `@bananasaurs/discord/rest` | Same, from the other side |
| `packages/cli/**` | `@bananasaurs/storage`, `better-sqlite3`, `drizzle-orm*` | ADR 0013: the CLI reaches the daemon over the socket and never opens the database |
| `packages/dashboard/**` | every server package | Different toolchain, static output, must not import server code |
| `packages/testkit/**` | `@bananasaurs/storage` | It is a devDependency of the others; shipping a fake into production should be a packaging error |

Rules for packages that do not exist yet are inert and bite the moment the directory appears. That is the point — WP5 inherits enforcement rather than having to remember to add it.

### 4. `exports` as the second layer, for deep paths

`packages/discord/package.json` will expose exactly two subpaths:

```json
"exports": { ".": "./dist/index.js", "./rest": "./dist/rest/index.js" }
```

Node and TypeScript refuse any other deep path for everyone, so the only way to reach the REST client is the one subpath the lint rule governs. `exports` handles "no sneaking in by file path"; the lint rule handles "who".

### 5. A test asserts the rules fire

`packages/core/src/boundaries.test.ts` runs ESLint programmatically over synthetic sources and asserts each restricted import is reported, and that the permitted one is not. Deleting a rule from `eslint.config.js` fails the test suite, not just the lint step — so the enforcement cannot be quietly removed to make something compile.

## Consequences

**What this gives up.** ESLint sees direct imports only. It does not compute transitive reachability and does not detect cycles, both of which `dependency-cruiser` does. Every rule above is a direct-import statement, so nothing is lost today. If a rule ever needs transitive analysis — "nothing under `http` may reach Discord through *any* chain" — this decision should be revisited, and `dependency-cruiser` is the answer at that point.

**An `eslint-disable` defeats it.** Accepted, and consistent with amendment 3's reasoning about the `Authorized` lint tripwire: the purpose is to make a bypass visible in a diff, not impossible. The control for the REST port is that `applyRoleEffect` re-verifies capability at runtime; this is the tripwire.

**The plan document is wrong and is corrected.** `docs/19` §1's enforcement sentence is amended in place to describe what is actually true.
