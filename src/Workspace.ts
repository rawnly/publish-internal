import { Context, Effect, FileSystem, Layer, Path, Predicate, Schema } from "effect"
import { ManifestError } from "./errors.ts"

export interface Catalogs {
  readonly default: Readonly<Record<string, string>>
  readonly named: Readonly<Record<string, Readonly<Record<string, string>>>>
}

export interface WorkspacePackage {
  readonly name: string
  readonly version: string
  readonly private: boolean
  /** Absolute directory. */
  readonly dir: string
  /** Directory relative to the workspace root ("." for a single package). */
  readonly relDir: string
  readonly manifestPath: string
  /** Raw manifest text, used to restore the file byte-for-byte. */
  readonly rawText: string
  readonly raw: Record<string, any>
  /** dependencies + optionalDependencies + peerDependencies names. */
  readonly runtimeDependencies: ReadonlyArray<string>
}

export interface WorkspaceInfo {
  readonly root: string
  readonly isMonorepo: boolean
  readonly packages: ReadonlyArray<WorkspacePackage>
  readonly catalogs: Catalogs
}

const StringRecord = Schema.Record(Schema.String, Schema.String)

const Manifest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  private: Schema.optionalKey(Schema.Boolean),
  dependencies: Schema.optionalKey(StringRecord),
  optionalDependencies: Schema.optionalKey(StringRecord),
  peerDependencies: Schema.optionalKey(StringRecord)
})

const asStringRecord = (u: unknown): Record<string, string> => {
  if (!Predicate.isObject(u)) return {}
  return Object.fromEntries(Object.entries(u).filter(([, v]) => Predicate.isString(v))) as Record<string, string>
}

const asStringArray = (u: unknown): Array<string> =>
  Array.isArray(u) ? u.filter(Predicate.isString) : []

const asNamedCatalogs = (u: unknown): Record<string, Record<string, string>> =>
  Predicate.isObject(u) ? Object.fromEntries(Object.entries(u).map(([k, v]) => [k, asStringRecord(v)])) : {}

interface RootConfig {
  readonly patterns: ReadonlyArray<string>
  readonly catalogs: Catalogs
}

const scanPackageDirs = (root: string, patterns: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const include = patterns.filter((p) => !p.startsWith("!"))
    const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => new Bun.Glob(p.slice(1).replace(/\/$/, "")))
    const found = new Set<string>()
    for (const pattern of include) {
      const glob = new Bun.Glob(`${pattern.replace(/^\.\//, "").replace(/\/$/, "")}/package.json`)
      for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
        if (file.split("/").includes("node_modules")) continue
        const dir = file.slice(0, -"/package.json".length)
        if (exclude.some((g) => g.match(dir))) continue
        found.add(dir)
      }
    }
    return [...found].sort()
  })

export class Workspace extends Context.Service<Workspace, {
  /** Discover the workspace (or the lone package) that contains `cwd`. */
  load(cwd: string): Effect.Effect<WorkspaceInfo, ManifestError>
}>()("publish-internal/Workspace") {
  static readonly layer = Layer.effect(
    Workspace,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const readText = (file: string) =>
        fs.readFileString(file).pipe(Effect.mapError((e) => new ManifestError({ path: file, message: String(e) })))

      const readJson = Effect.fn("Workspace.readJson")(function*(file: string) {
        const text = yield* readText(file)
        const value = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (e) => new ManifestError({ path: file, message: `invalid JSON: ${String(e)}` })
        })
        return [text, value] as const
      })

      const rootConfigAt = Effect.fn("Workspace.rootConfigAt")(function*(dir: string) {
        const patterns: Array<string> = []
        let catalogs: Catalogs = { default: {}, named: {} }
        let found = false

        const yamlPath = path.join(dir, "pnpm-workspace.yaml")
        if (yield* fs.exists(yamlPath).pipe(Effect.orElseSucceed(() => false))) {
          const text = yield* readText(yamlPath)
          const yaml = yield* Effect.try({
            try: () => (Bun as any).YAML.parse(text) as unknown,
            catch: (e) => new ManifestError({ path: yamlPath, message: String(e) })
          })
          if (Predicate.isObject(yaml)) {
            patterns.push(...asStringArray(yaml.packages))
            catalogs = { default: asStringRecord(yaml.catalog), named: asNamedCatalogs(yaml.catalogs) }
            found = true
          }
        }

        const pkgPath = path.join(dir, "package.json")
        if (yield* fs.exists(pkgPath).pipe(Effect.orElseSucceed(() => false))) {
          const [, json] = yield* readJson(pkgPath)
          if (Predicate.isObject(json)) {
            const ws = json.workspaces
            const wsObj = Predicate.isObject(ws) && !Array.isArray(ws) ? ws : undefined
            const wsPatterns = Array.isArray(ws) ? asStringArray(ws) : asStringArray(wsObj?.packages)
            if (wsPatterns.length > 0) {
              patterns.push(...wsPatterns)
              found = true
            }
            // bun / yarn: catalogs on the root manifest or inside `workspaces`
            const def = { ...asStringRecord(json.catalog), ...asStringRecord(wsObj?.catalog) }
            const named = { ...asNamedCatalogs(json.catalogs), ...asNamedCatalogs(wsObj?.catalogs) }
            catalogs = {
              default: { ...catalogs.default, ...def },
              named: { ...catalogs.named, ...named }
            }
          }
        }
        return found ? ({ patterns, catalogs } satisfies RootConfig) : undefined
      })

      const findRoot = Effect.fn("Workspace.findRoot")(function*(cwd: string) {
        let dir = cwd
        while (true) {
          const config = yield* rootConfigAt(dir)
          if (config) return [dir, config] as const
          const parent = path.dirname(dir)
          if (parent === dir) return undefined
          dir = parent
        }
      })

      const loadPackage = Effect.fn("Workspace.loadPackage")(function*(root: string, dir: string) {
        const manifestPath = path.join(dir, "package.json")
        const [rawText, raw] = yield* readJson(manifestPath)
        const m = yield* Schema.decodeUnknownEffect(Manifest)(raw).pipe(
          Effect.mapError((e) => new ManifestError({ path: manifestPath, message: String(e) }))
        )
        if (!m.name) return undefined
        return {
          name: m.name,
          version: m.version ?? "0.0.0",
          private: m.private ?? false,
          dir,
          relDir: path.relative(root, dir) || ".",
          manifestPath,
          rawText,
          raw: raw as Record<string, any>,
          runtimeDependencies: [
            ...Object.keys(m.dependencies ?? {}),
            ...Object.keys(m.optionalDependencies ?? {}),
            ...Object.keys(m.peerDependencies ?? {})
          ]
        } satisfies WorkspacePackage
      })

      const load = Effect.fn("Workspace.load")(function*(cwd: string) {
        const absolute = path.resolve(cwd)
        const located = yield* findRoot(absolute)

        if (!located) {
          const single = yield* loadPackage(absolute, absolute)
          if (!single) {
            return yield* new ManifestError({ path: path.join(absolute, "package.json"), message: 'missing "name"' })
          }
          return { root: absolute, isMonorepo: false, packages: [single], catalogs: { default: {}, named: {} } }
        }

        const [root, config] = located
        const dirs = yield* scanPackageDirs(root, config.patterns)
        const loaded = yield* Effect.forEach(dirs, (d) => loadPackage(root, path.join(root, d)), { concurrency: 8 })
        return {
          root,
          isMonorepo: true,
          packages: loaded.filter(Predicate.isNotUndefined),
          catalogs: config.catalogs
        } satisfies WorkspaceInfo
      })

      return Workspace.of({ load })
    })
  )
}
