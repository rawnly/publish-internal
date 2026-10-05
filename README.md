# publish-internal

Publish **internal / prerelease builds** of a package — or a whole monorepo — to any npm-compatible registry under a dist-tag, without ever committing a version bump.

```
@acme/ui  1.2.0  →  @acme/ui@1.2.0-internal.a1b2c3d.0   (dist-tag: internal)
npm i @acme/ui@internal
```

- **Monorepo-aware** — npm / yarn / bun `workspaces` and `pnpm-workspace.yaml`
- **Affected-only publishing** — `--since origin/main` publishes changed packages *and their dependents*
- **Dependency order** — dependencies always publish first
- **Rewrites** `workspace:*|^|~` and `catalog:` / `catalog:<name>` to real versions in the published manifest
- **Safe** — manifests are restored byte-for-byte, even when a publish fails
- **Any registry** — npmjs, GitHub Packages, Verdaccio, Artifactory, …
- **CLI + SDK + GitHub Action**
- Built with [Effect](https://effect.website) v4 (services, layers, `effect/cli`)

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [Versioning](#versioning)
- [Monorepos](#monorepos)
- [Registries & authentication](#registries--authentication)
- [GitHub Action](#github-action)
- [SDK](#sdk)
- [How it works](#how-it-works)
- [Development](#development)
- [Roadmap](#roadmap)
- [License](#license)

## Install

Requires [Bun](https://bun.sh) ≥ 1.2 (the CLI runs TypeScript directly) and `npm` (or `pnpm` / `bun`) on `PATH` for the actual publish.

```bash
bun add -d publish-internal      # project dependency
bunx publish-internal --help     # or run ad hoc
```

## Quick start

```bash
# Build first (or pass --build), then:
publish-internal --plan          # see what would be published
publish-internal --dry-run       # run `npm publish --dry-run`
publish-internal                 # publish for real
```

| Command | What it does |
|---|---|
| `publish-internal` | Publishes the package in the current directory (single repo, or the workspace package you're `cd`'d into) |
| `publish-internal ui` | One workspace package, by name, directory, or directory basename |
| `publish-internal --all` | Every non-private workspace package |
| `publish-internal -f "@acme/*"` | Packages matching a name glob (repeatable) |
| `publish-internal --all --since origin/main` | Only packages affected by this branch |
| `publish-internal --tag next --registry https://npm.pkg.github.com` | Custom dist-tag and registry |

## CLI reference

```
publish-internal [flags] [<package...>]
```

| Flag | Default | Description |
|---|---|---|
| `<package...>` | package in cwd | Names, directories or directory basenames |
| `--all` | `false` | Select every non-private workspace package |
| `-f, --filter <glob>` | | Name glob, repeatable (`"@acme/*"`) |
| `--since <ref>` | | Only packages changed since `<ref>`, plus their dependents |
| `-t, --tag <tag>` | `internal` | npm dist-tag |
| `--version-template <tpl>` | `{version}-{tag}.{sha}.{n}` | See [Versioning](#versioning) |
| `--registry <url>` | npm default | Registry URL |
| `--token <token>` | `$NODE_AUTH_TOKEN` (when `--registry` is set) | Auth token |
| `--client <npm\|pnpm\|bun>` | `npm` | Tool used to run `publish` |
| `--access <public\|restricted>` | | Passed to `publish --access` |
| `--provenance` | `false` | Attach npm provenance (needs OIDC) |
| `--build` | `false` | Run each package's `build` script first |
| `--plan` | `false` | Print versions only; touch nothing |
| `--dry-run` | `false` | Run `publish --dry-run` (nothing is uploaded) |
| `--allow-dirty` | `false` | Don't stop on an unclean git tree |
| `--allow-latest` | `false` | Permit `--tag latest` (blocked by default) |
| `--json` | `false` | Machine-readable output |
| `--cwd <dir>` | `process.cwd()` | Working directory |

Exit code is `0` on success, `1` on any failure, with a human-readable message on stderr.

## Versioning

Each published version is `base version` + a prerelease suffix built from a template:

```
{version}-{tag}.{sha}.{n}   →   1.2.0-internal.a1b2c3d.0
```

| Placeholder | Value |
|---|---|
| `{version}` | Version in `package.json` (build metadata stripped) |
| `{tag}` | The dist-tag, sanitized for semver |
| `{sha}` | Short git commit hash |
| `{branch}` | Current branch, sanitized |
| `{timestamp}` | `YYYYMMDDHHMMSS` (UTC) |
| `{run}` | `$GITHUB_RUN_NUMBER` (or `0`) |
| `{n}` | Build counter: highest matching version on the registry + 1 |

Examples:

```bash
--version-template "{version}-{tag}.{sha}.{n}"      # default; re-publishing the same commit bumps {n}
--version-template "{version}-{branch}.{run}"       # 1.2.0-feature-x.481
--version-template "{version}-{tag}.{timestamp}"    # 1.2.0-internal.20250101120000
```

Git is only queried for placeholders the template actually uses.

## Monorepos

Workspaces are detected by walking up from `--cwd`:

- `workspaces` in `package.json` (array form or `{ packages, catalog, catalogs }`)
- `pnpm-workspace.yaml` (`packages`, `catalog`, `catalogs`)

Behaviour:

1. **Selection** — positional names, `--all`, `--filter`, `--since` (combine freely; `--since` narrows the others). Private packages are skipped unless named explicitly.
2. **Affected** — `--since <ref>` diffs against the merge-base (`ref...HEAD`) plus uncommitted and untracked files, maps files to packages, then adds every package that depends on them, transitively.
3. **Ordering** — topological over `dependencies`, `optionalDependencies` and `peerDependencies`. Cycles are reported as an error.
4. **Rewriting** (in the published manifest only):

   | In source | Published as |
   |---|---|
   | `"core": "workspace:*"` | `"1.0.0-internal.abc.2"` |
   | `"core": "workspace:^"` | `"^1.0.0-internal.abc.2"` |
   | `"core": "workspace:~"` | `"~1.0.0-internal.abc.2"` |
   | `"zod": "catalog:"` | the default catalog entry |
   | `"react": "catalog:react18"` | entry from the `react18` catalog |

   Internal packages that are *not* part of this run resolve to their current manifest version.
5. **Publish** — one package at a time: rewrite → publish → restore.

## Registries & authentication

Any npm-protocol registry works:

```bash
# GitHub Packages
publish-internal --registry https://npm.pkg.github.com --token "$GITHUB_TOKEN"

# Self-hosted (Verdaccio, Artifactory, …)
NODE_AUTH_TOKEN=... publish-internal --registry https://npm.example.com/
```

When both a registry and a token are provided, a temporary `.npmrc` is generated (mode `0600`), passed with `--userconfig`, and deleted afterwards. Credentials never touch your repository or your own `~/.npmrc`. Without `--registry`, your existing npm configuration is used as-is.

> **Note:** `ghcr.io` is a *container* registry, not an npm registry. For GitHub use `https://npm.pkg.github.com`. Publishing as an OCI artifact is not supported yet.
>
> `--client bun` ignores `--userconfig`, so token injection works with `npm` and `pnpm`.

## GitHub Action

```yaml
name: Publish internal
on:
  pull_request:
  push: { branches: [main] }

permissions:
  contents: read
  packages: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }            # required for `since`
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build
      - uses: <owner>/publish-internal@v1
        id: publish
        with:
          all: true
          since: origin/main
          tag: internal
          registry: https://npm.pkg.github.com
          token: ${{ secrets.GITHUB_TOKEN }}
      - run: echo '${{ steps.publish.outputs.published }}'
```

| Input | Default | |
|---|---|---|
| `packages` | | Space-separated names/dirs |
| `all` | `false` | |
| `filter` | | Space-separated globs |
| `since` | | Git ref |
| `tag` | `internal` | |
| `version-template` | `{version}-{tag}.{sha}.{n}` | |
| `registry` | npmjs | |
| `token` | | Auth token |
| `client` | `npm` | `npm` \| `pnpm` \| `bun` |
| `access` | | `public` \| `restricted` |
| `provenance` | `false` | Needs `id-token: write` |
| `build` | `false` | Run each package's build script |
| `dry-run` | `false` | |
| `working-directory` | `.` | |

**Output:** `published` — JSON array of `{ name, version, tag, dir, registry, published }`. A summary table is also written to the job summary.

## SDK

### Promises (Bun)

```ts
import { planInternal, publishInternal } from "publish-internal/bun"

const plan = await planInternal({ all: true, since: "origin/main" })
const results = await publishInternal({
  all: true,
  tag: "next",
  registry: "https://npm.pkg.github.com",
})
// [{ name, version, tag, dir, registry, published }]
```

### Effect

The core is platform-agnostic; provide `FileSystem`, `Path` and `ChildProcessSpawner` (e.g. `BunServices.layer` or `NodeServices.layer`).

```ts
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Publisher, layer } from "publish-internal"

const program = Effect.gen(function*() {
  const publisher = yield* Publisher
  const plan = yield* publisher.plan({ all: true })
  yield* Effect.log(plan.packages.map((p) => `${p.pkg.name}@${p.version}`))
  return yield* publisher.publish({ all: true })
}).pipe(Effect.provide(layer), Effect.provide(BunServices.layer))
```

Every piece is a replaceable service — handy for tests:

| Service | Responsibility |
|---|---|
| `Publisher` | `plan` / `publish` orchestration |
| `Workspace` | Package & catalog discovery |
| `Git` | sha, branch, clean check, changed files |
| `Registry` | existing versions, publish, auth target |
| `Exec` | process runner |

Pure helpers are exported too: `nextVersion`, `renderVersion`, `topologicalSort`, `withDependents`, `rewriteManifest`, `resolveSpecifier`.

Errors are tagged (`ManifestError`, `PackageNotFound`, `NoPackagesSelected`, `DependencyCycle`, `DirtyTree`, `InvalidOption`, `CommandError`, `RegistryError`, `PublishFailed`) so you can `Effect.catchTag` them.

## How it works

```
select packages ─▶ topo-sort ─▶ query registry for existing versions ─▶ compute versions
                                                                             │
        restore package.json ◀─ publish ◀─ rewrite manifest (version, workspace:, catalog:)
                 (always)         (npm/pnpm/bun)            ▲
                                                            └── repeated per package, dependencies first
```

## Development

```bash
bun install
bun run typecheck
bun run test         # unit + integration tests with fake services
bun run cli -- --plan
```

Layout: `src/` holds one file per service (`Workspace`, `Git`, `Registry`, `Publisher`, `Exec`), pure logic (`Version`, `Graph`, `Rewrite`), and entry points (`cli.ts`, `bun.ts`, `index.ts`). Contributions welcome — please add a test with any behaviour change.

## Roadmap

- Config file (`publish-internal.config.ts`)
- `promote` (move an internal build to `next` / `latest`) and `prune` old versions
- PR comment with install instructions
- OCI (ghcr.io) backend
- Local Verdaccio mode for testing

## License

MIT
