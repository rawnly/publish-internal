import { Context, Effect, FileSystem, Layer, Redacted, type Scope } from "effect"
import { CommandError, RegistryError } from "./errors.ts"
import { Exec } from "./Exec.ts"

export type Client = "npm" | "pnpm" | "bun"

/** Where to talk to. `userconfig` is a generated .npmrc carrying the auth token. */
export interface RegistryTarget {
  readonly registry: string | undefined
  readonly userconfig: string | undefined
}

export interface PublishArgs {
  readonly dir: string
  readonly client: Client
  readonly tag: string
  readonly access: "public" | "restricted" | undefined
  readonly provenance: boolean
  readonly dryRun: boolean
  readonly target: RegistryTarget
}

const targetArgs = (t: RegistryTarget): Array<string> => [
  ...(t.registry ? ["--registry", t.registry] : []),
  ...(t.userconfig ? ["--userconfig", t.userconfig] : [])
]

export const npmrcContents = (registry: string, token: string): string => {
  const url = new URL(registry)
  const prefix = `//${url.host}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`
  return `registry=${registry}\n${prefix}:_authToken=${token}\nalways-auth=true\n`
}

export class Registry extends Context.Service<Registry, {
  /**
   * Build a target. When both a registry and a token are given, a temporary
   * .npmrc is generated (and removed with the scope) so credentials never touch
   * the repository or the user's own config.
   */
  target(options: {
    readonly registry?: string | undefined
    readonly token?: Redacted.Redacted<string> | undefined
  }): Effect.Effect<RegistryTarget, RegistryError, Scope.Scope>
  /** All versions of `name` on the registry ([] if the package does not exist yet). */
  versions(name: string, target: RegistryTarget): Effect.Effect<ReadonlyArray<string>, RegistryError>
  publish(args: PublishArgs): Effect.Effect<string, CommandError>
}>()("publish-internal/Registry") {
  static readonly layer = Layer.effect(
    Registry,
    Effect.gen(function*() {
      const exec = yield* Exec
      const fs = yield* FileSystem.FileSystem

      const target = Effect.fn("Registry.target")(function*(options: {
        readonly registry?: string | undefined
        readonly token?: Redacted.Redacted<string> | undefined
      }) {
        if (!options.registry || !options.token) {
          return { registry: options.registry, userconfig: undefined } satisfies RegistryTarget
        }
        if (!URL.canParse(options.registry)) {
          return yield* new RegistryError({ message: `invalid registry URL: ${options.registry}` })
        }
        const file = yield* fs.makeTempFileScoped({ prefix: "publish-internal-", suffix: ".npmrc" }).pipe(
          Effect.mapError((e) => new RegistryError({ message: String(e) }))
        )
        yield* fs.writeFileString(file, npmrcContents(options.registry, Redacted.value(options.token)), { mode: 0o600 })
          .pipe(Effect.mapError((e) => new RegistryError({ message: String(e) })))
        return { registry: options.registry, userconfig: file } satisfies RegistryTarget
      })

      const versions = Effect.fn("Registry.versions")(function*(name: string, t: RegistryTarget) {
        const r = yield* exec.run("npm", ["view", name, "versions", "--json", ...targetArgs(t)]).pipe(
          Effect.mapError((e) => new RegistryError({ message: e.stderr }))
        )
        // `npm view` can exit non-zero when there is no "latest" dist-tag but
        // still print versions, so trust stdout first and only then look at 404.
        const raw = r.stdout.trim()
        if (raw) {
          try {
            const parsed: unknown = JSON.parse(raw)
            if (Array.isArray(parsed)) return parsed.map(String)
            if (typeof parsed === "string") return [parsed]
          } catch { /* fall through */ }
        }
        if (r.stderr.includes("E404") || r.stdout.includes("E404")) return []
        if (r.exitCode === 0) return []
        return yield* new RegistryError({ message: `npm view ${name} failed: ${r.stderr.trim()}` })
      })

      const publish = Effect.fn("Registry.publish")(function*(a: PublishArgs) {
        const common = [
          "publish",
          "--tag",
          a.tag,
          ...(a.access ? ["--access", a.access] : []),
          ...(a.dryRun ? ["--dry-run"] : []),
          ...targetArgs(a.target)
        ]
        const [bin, args] = a.client === "pnpm"
          ? ["pnpm", [...common, "--no-git-checks", ...(a.provenance ? ["--provenance"] : [])]] as const
          : a.client === "bun"
          ? ["bun", common] as const
          : ["npm", [...common, ...(a.provenance ? ["--provenance"] : [])]] as const
        const r = yield* exec.ok(bin, args, { cwd: a.dir })
        return (r.stdout + r.stderr).trim()
      })

      return Registry.of({ target, versions, publish })
    })
  )
}
