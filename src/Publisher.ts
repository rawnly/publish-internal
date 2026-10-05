import { Context, DateTime, Effect, FileSystem, Layer, Path, type Redacted } from "effect"
import {
  type DependencyCycle,
  InvalidOption,
  ManifestError,
  NoPackagesSelected,
  PackageNotFound,
  PublishFailed,
  type PublishError
} from "./errors.ts"
import { Exec } from "./Exec.ts"
import { Git } from "./Git.ts"
import { topologicalSort, withDependents } from "./Graph.ts"
import { type Client, Registry, type RegistryTarget } from "./Registry.ts"
import { rewriteManifest } from "./Rewrite.ts"
import { DEFAULT_TEMPLATE, nextVersion, sanitize, unknownPlaceholders } from "./Version.ts"
import { Workspace, type WorkspaceInfo, type WorkspacePackage } from "./Workspace.ts"

export interface PublishOptions {
  /** Directory to start from (default: process.cwd()). */
  readonly cwd?: string | undefined
  /** Package names, directories or dir basenames. */
  readonly packages?: ReadonlyArray<string> | undefined
  /** Select every non-private workspace package. */
  readonly all?: boolean | undefined
  /** Name globs, e.g. "@scope/*". Repeatable. */
  readonly filter?: ReadonlyArray<string> | undefined
  /** Only packages changed (or depending on changed ones) since this git ref. */
  readonly since?: string | undefined
  /** npm dist-tag. Default "internal". */
  readonly tag?: string | undefined
  /** See Version.ts. Default "{version}-{tag}.{sha}.{n}". */
  readonly versionTemplate?: string | undefined
  readonly registry?: string | undefined
  readonly token?: Redacted.Redacted<string> | undefined
  readonly client?: Client | undefined
  readonly access?: "public" | "restricted" | undefined
  readonly provenance?: boolean | undefined
  /** Simulate the publish (`npm publish --dry-run`). */
  readonly dryRun?: boolean | undefined
  /** Run `<client> run build --if-present` in each package first. */
  readonly build?: boolean | undefined
  /** Permit `--tag latest`. */
  readonly allowLatest?: boolean | undefined
  /** Extra template variables (e.g. `run`). */
  readonly vars?: Readonly<Record<string, string>> | undefined
}

export interface PlannedPackage {
  readonly pkg: WorkspacePackage
  readonly version: string
}

export interface Plan {
  readonly workspace: WorkspaceInfo
  readonly tag: string
  readonly registry: string | undefined
  /** Dependencies first. */
  readonly packages: ReadonlyArray<PlannedPackage>
}

export interface PublishResult {
  readonly name: string
  readonly version: string
  readonly tag: string
  readonly dir: string
  readonly registry: string | undefined
  /** false for dry runs */
  readonly published: boolean
}

const globMatch = (pattern: string, value: string) => new Bun.Glob(pattern).match(value)

export class Publisher extends Context.Service<Publisher, {
  /** Resolve selection + versions without touching anything. */
  plan(options: PublishOptions): Effect.Effect<Plan, PublishError>
  /** Plan, then rewrite → publish → restore each manifest in dependency order. */
  publish(options: PublishOptions): Effect.Effect<ReadonlyArray<PublishResult>, PublishError>
}>()("publish-internal/Publisher") {
  static readonly layer = Layer.effect(
    Publisher,
    Effect.gen(function*() {
      const workspace = yield* Workspace
      const git = yield* Git
      const registry = yield* Registry
      const exec = yield* Exec
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const select = Effect.fn("Publisher.select")(function*(ws: WorkspaceInfo, o: PublishOptions, cwd: string) {
        const names = o.packages ?? []
        const filters = o.filter ?? []
        const explicit = names.length > 0
        const publicPkgs = ws.packages.filter((p) => !p.private)

        const resolveName = (q: string) => {
          const stripped = q.replace(/^\.\//, "").replace(/\/$/, "")
          return ws.packages.find((p) =>
            p.name === q || p.relDir === stripped || path.basename(p.dir) === stripped ||
            p.name.replace(/^@[^/]+\//, "") === stripped
          )
        }

        let candidates: ReadonlyArray<WorkspacePackage>
        if (explicit || filters.length > 0 || o.all) {
          const set = new Map<string, WorkspacePackage>()
          for (const q of names) {
            const hit = resolveName(q)
            if (!hit) {
              return yield* new PackageNotFound({ query: q, available: ws.packages.map((p) => p.name) })
            }
            set.set(hit.name, hit)
          }
          for (const f of filters) {
            for (const p of publicPkgs) if (globMatch(f, p.name)) set.set(p.name, p)
          }
          if (o.all) for (const p of publicPkgs) set.set(p.name, p)
          candidates = [...set.values()]
        } else if (o.since) {
          candidates = publicPkgs
        } else if (!ws.isMonorepo) {
          candidates = ws.packages
        } else {
          // default: the package containing cwd
          const here = ws.packages
            .filter((p) => cwd === p.dir || cwd.startsWith(p.dir + path.sep))
            .sort((a, b) => b.dir.length - a.dir.length)[0]
          if (!here) {
            return yield* new NoPackagesSelected({
              message: "Not inside a package. Pass package names, --all, --filter or --since."
            })
          }
          candidates = [here]
        }

        if (o.since) {
          const changedFiles = yield* git.changedSince(ws.root, o.since)
          const changedPkgs = new Set<string>()
          for (const file of changedFiles) {
            const owner = ws.packages
              .filter((p) => file.startsWith(p.dir + path.sep))
              .sort((a, b) => b.dir.length - a.dir.length)[0]
            if (owner) changedPkgs.add(owner.name)
          }
          const affected = new Set(
            withDependents(ws.packages, ws.packages.filter((p) => changedPkgs.has(p.name))).map((p) => p.name)
          )
          candidates = candidates.filter((p) => affected.has(p.name))
        }

        // private packages are only publishable when named explicitly
        const explicitNames = new Set(names.map((n) => resolveName(n)?.name))
        candidates = candidates.filter((p) => !p.private || explicitNames.has(p.name))

        if (candidates.length === 0) {
          return yield* new NoPackagesSelected({
            message: o.since ? `No publishable packages changed since ${o.since}.` : "No publishable packages matched."
          })
        }

        const [sorted, cycle] = topologicalSort(candidates)
        if (cycle) return yield* (cycle satisfies DependencyCycle)
        return sorted
      })

      const computePlan = Effect.fn("Publisher.computePlan")(function*(o: PublishOptions, target: RegistryTarget) {
        const tag = o.tag ?? "internal"
        const template = o.versionTemplate ?? DEFAULT_TEMPLATE
        const bad = unknownPlaceholders(template)
        if (bad.length > 0) {
          return yield* new InvalidOption({ message: `unknown placeholder(s) in version template: ${bad.map((b) => `{${b}}`).join(", ")}` })
        }
        if (tag === "latest" && !o.allowLatest) {
          return yield* new InvalidOption({ message: 'refusing to publish to the "latest" dist-tag without --allow-latest (allowLatest in the SDK)' })
        }

        const cwd = path.resolve(o.cwd ?? process.cwd())
        const ws = yield* workspace.load(cwd)
        const selected = yield* select(ws, o, cwd)

        // only touch git for the values the template actually uses
        const [sha, branch, now] = yield* Effect.all([
          template.includes("{sha}") ? git.sha(ws.root) : Effect.succeed(""),
          template.includes("{branch}") ? git.branch(ws.root) : Effect.succeed(""),
          DateTime.now
        ])
        const timestamp = DateTime.formatIso(now).replace(/\D/g, "").slice(0, 14)

        const packages = yield* Effect.forEach(selected, (pkg) =>
          Effect.gen(function*() {
            const existing = yield* registry.versions(pkg.name, target)
            const vars = {
              version: pkg.version.split("+")[0]!,
              tag: sanitize(tag),
              sha,
              branch: sanitize(branch),
              timestamp,
              run: "0",
              ...o.vars
            }
            return { pkg, version: nextVersion(template, vars, existing) } satisfies PlannedPackage
          }), { concurrency: 4 })

        return { workspace: ws, tag, registry: o.registry, packages } satisfies Plan
      })

      const scopedTarget = (o: PublishOptions) => registry.target({ registry: o.registry, token: o.token })

      const plan = (o: PublishOptions) =>
        Effect.scoped(Effect.flatMap(scopedTarget(o), (t) => computePlan(o, t)))

      const ioError = (file: string) => Effect.mapError((e: unknown) => new ManifestError({ path: file, message: String(e) }))

      const publishOne = Effect.fn("Publisher.publishOne")(function*(
        p: PlannedPackage,
        pl: Plan,
        o: PublishOptions,
        target: RegistryTarget
      ) {
        const { pkg, version } = p
        const workspaceVersions = new Map(pl.workspace.packages.map((w) => [w.name, w.version]))
        for (const planned of pl.packages) workspaceVersions.set(planned.pkg.name, planned.version)

        const { manifest, errors } = rewriteManifest(pkg.raw, {
          version,
          workspaceVersions,
          catalogs: pl.workspace.catalogs
        })
        if (errors.length > 0) {
          return yield* new ManifestError({ path: pkg.manifestPath, message: errors.join("; ") })
        }
        const indent = /^(\s+)"/m.exec(pkg.rawText)?.[1] ?? "  "
        const trailing = pkg.rawText.endsWith("\n") ? "\n" : ""
        const text = JSON.stringify(manifest, null, indent) + trailing
        const client = o.client ?? "npm"

        if (o.build) {
          const buildArgs = client === "bun" ? ["run", "--if-present", "build"] : ["run", "build", "--if-present"]
          yield* exec.ok(client, buildArgs, { cwd: pkg.dir }).pipe(
            Effect.mapError((e) => new PublishFailed({ name: pkg.name, version, message: `build failed: ${e.stderr}` }))
          )
        }

        // Always put the original manifest back, even on failure/interrupt.
        yield* Effect.acquireRelease(
          fs.writeFileString(pkg.manifestPath, text).pipe(ioError(pkg.manifestPath)),
          () => fs.writeFileString(pkg.manifestPath, pkg.rawText).pipe(Effect.orDie)
        )

        const output = yield* registry.publish({
          dir: pkg.dir,
          client,
          tag: pl.tag,
          access: o.access,
          provenance: o.provenance ?? false,
          dryRun: o.dryRun ?? false,
          target
        }).pipe(
          Effect.mapError((e) => new PublishFailed({ name: pkg.name, version, message: e.stderr }))
        )
        yield* Effect.logDebug(output)

        return {
          name: pkg.name,
          version,
          tag: pl.tag,
          dir: pkg.dir,
          registry: o.registry,
          published: !(o.dryRun ?? false)
        } satisfies PublishResult
      }, Effect.scoped)

      const publish = (o: PublishOptions) =>
        Effect.scoped(
          Effect.gen(function*() {
            const target = yield* scopedTarget(o)
            const pl = yield* computePlan(o, target)
            return yield* Effect.forEach(pl.packages, (p) => publishOne(p, pl, o, target), { concurrency: 1 })
          })
        )

      return Publisher.of({ plan, publish })
    })
  )
}
