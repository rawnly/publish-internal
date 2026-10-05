#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Option, Redacted } from "effect"
import { Argument, Command, Flag, Prompt } from "effect/cli"
import { describeError, DirtyTree, type PublishError } from "./errors.ts"
import { Git } from "./Git.ts"
import { layer } from "./layer.ts"
import { Publisher, type PublishResult } from "./Publisher.ts"

const RED = process.stderr.isTTY ? "\x1b[31m" : ""
const RESET = process.stderr.isTTY ? "\x1b[0m" : ""
const TAGS = new Set(["ManifestError", "PackageNotFound", "NoPackagesSelected", "DependencyCycle", "DirtyTree", "InvalidOption", "CommandError", "RegistryError", "PublishFailed"])
const isPublishError = (e: { readonly _tag?: string }): e is PublishError => TAGS.has(e._tag ?? "")

const opt = <A>(o: Option.Option<A>): A | undefined => Option.getOrUndefined(o)

const publishInternal = Command.make(
  "publish-internal",
  {
    packages: Argument.String("package").pipe(
      Argument.withDescription("Package name, directory or directory basename (monorepo). Defaults to the package in cwd."),
      Argument.variadic()
    ),
    all: Flag.Boolean("all").pipe(Flag.withDescription("Publish every non-private workspace package"), Flag.withDefault(false)),
    filter: Flag.String("filter").pipe(
      Flag.withAlias("f"),
      Flag.withDescription('Package-name glob, e.g. "@acme/*" (repeatable)'),
      Flag.atLeast(0)
    ),
    since: Flag.String("since").pipe(
      Flag.withDescription("Only packages changed since this git ref (plus their dependents)"),
      Flag.optional
    ),
    tag: Flag.String("tag").pipe(
      Flag.withAlias("t"),
      Flag.withDescription("npm dist-tag to publish under"),
      Flag.withDefault("internal")
    ),
    versionTemplate: Flag.String("version-template").pipe(
      Flag.withDescription("Placeholders: {version} {tag} {sha} {branch} {timestamp} {run} {n}"),
      Flag.withDefault("{version}-{tag}.{sha}.{n}")
    ),
    registry: Flag.String("registry").pipe(
      Flag.withDescription("Registry URL (e.g. https://npm.pkg.github.com)"),
      Flag.optional
    ),
    token: Flag.Redacted("token").pipe(
      Flag.withDescription("Auth token (default: $NODE_AUTH_TOKEN when --registry is set)"),
      Flag.optional
    ),
    client: Flag.Literals("client", ["npm", "pnpm", "bun"]).pipe(
      Flag.withDescription("Tool used to publish"),
      Flag.withDefault("npm")
    ),
    access: Flag.Literals("access", ["public", "restricted"]).pipe(Flag.optional),
    provenance: Flag.Boolean("provenance").pipe(Flag.withDescription("Attach npm provenance (needs OIDC)"), Flag.withDefault(false)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDescription("Run `publish --dry-run` (nothing is uploaded)"), Flag.withDefault(false)),
    plan: Flag.Boolean("plan").pipe(Flag.withDescription("Only print what would be published"), Flag.withDefault(false)),
    build: Flag.Boolean("build").pipe(Flag.withDescription("Run the package `build` script first"), Flag.withDefault(false)),
    allowDirty: Flag.Boolean("allow-dirty").pipe(Flag.withDescription("Do not ask when the working tree is dirty"), Flag.withDefault(false)),
    allowLatest: Flag.Boolean("allow-latest").pipe(Flag.withDescription('Permit --tag latest'), Flag.withDefault(false)),
    json: Flag.Boolean("json").pipe(Flag.withDescription("Print results as JSON"), Flag.withDefault(false)),
    cwd: Flag.String("cwd").pipe(Flag.withDescription("Working directory"), Flag.optional)
  },
  Effect.fn("publish-internal")(function*(f) {
    const publisher = yield* Publisher
    const git = yield* Git
    const cwd = opt(f.cwd) ?? process.cwd()

    const envToken = f.registry._tag === "Some" && process.env.NODE_AUTH_TOKEN
      ? Redacted.make(process.env.NODE_AUTH_TOKEN)
      : undefined

    const options = {
      cwd,
      packages: f.packages,
      all: f.all,
      filter: f.filter,
      since: opt(f.since),
      tag: f.tag,
      versionTemplate: f.versionTemplate,
      registry: opt(f.registry),
      token: opt(f.token) ?? envToken,
      client: f.client,
      access: opt(f.access),
      provenance: f.provenance,
      dryRun: f.dryRun,
      build: f.build,
      allowLatest: f.allowLatest,
      vars: { run: process.env.GITHUB_RUN_NUMBER ?? "0" }
    } as const

    if (f.plan) {
      const plan = yield* publisher.plan(options)
      if (f.json) {
        return yield* Console.log(JSON.stringify(plan.packages.map((p) => ({ name: p.pkg.name, version: p.version, tag: plan.tag })), null, 2))
      }
      yield* Console.log(`Plan (tag: ${plan.tag})`)
      for (const p of plan.packages) yield* Console.log(`  ${p.pkg.name}@${p.version}`)
      return
    }

    if (!f.allowDirty && !f.dryRun) {
      const clean = yield* git.isClean(cwd)
      if (!clean) {
        yield* Console.warn("Warning: unclean working directory. Publishing may lead to unexpected results.")
        if (!process.stdin.isTTY) return yield* new DirtyTree({})
        const ok = yield* Prompt.run(Prompt.Confirm({ message: "Continue?", initial: false }))
        if (!ok) return yield* new DirtyTree({})
      }
    }

    const results = yield* publisher.publish(options)

    if (f.json) yield* Console.log(JSON.stringify(results, null, 2))
    else {
      for (const r of results) {
        yield* Console.log(`${r.published ? "Published" : "[dry-run]"} ${r.name}@${r.version} (tag: ${r.tag})`)
      }
    }
    yield* writeCiOutputs(results)
  }, (eff) =>
    eff.pipe(
      Effect.catch((e: PublishError | { readonly _tag?: string }) =>
        Console.error(
          `${RED}error${RESET}: ${"_tag" in e && e._tag && isPublishError(e) ? describeError(e) : "cancelled"}`
        ).pipe(Effect.andThen(Effect.sync(() => { process.exitCode = 1 })))
      )
    ))
).pipe(
  Command.withDescription("Publish prerelease builds of a package (or monorepo) under a dist-tag."),
  Command.withExamples([
    { command: "publish-internal", description: "Single repo, or the package in cwd" },
    { command: "publish-internal ui", description: "One workspace package by name or directory" },
    { command: "publish-internal --all --since origin/main", description: "Everything affected by this branch" },
    { command: 'publish-internal -f "@acme/*" --tag next --registry https://npm.pkg.github.com', description: "Custom tag and registry" }
  ])
)

/** GitHub Actions integration: step outputs + job summary. No-ops elsewhere. */
const writeCiOutputs = Effect.fn("writeCiOutputs")(function*(results: ReadonlyArray<PublishResult>) {
  const fs = yield* FileSystem.FileSystem
  const out = process.env.GITHUB_OUTPUT
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (out) yield* fs.writeFileString(out, `published=${JSON.stringify(results)}\n`, { flag: "a" })
  if (summary) {
    const rows = results.map((r) => `| \`${r.name}\` | \`${r.version}\` | \`${r.tag}\` |`).join("\n")
    yield* fs.writeFileString(summary, `### Published\n\n| Package | Version | Tag |\n|---|---|---|\n${rows}\n`, { flag: "a" })
  }
}, (eff) => Effect.ignore(eff))

const main = layer.pipe(Layer.provideMerge(BunServices.layer))

publishInternal.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(main),
  BunRuntime.runMain
)
