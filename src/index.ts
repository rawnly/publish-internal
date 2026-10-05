/**
 * publish-internal SDK (Effect-first, platform-agnostic).
 *
 * ```ts
 * import { Effect } from "effect"
 * import { BunServices } from "@effect/platform-bun"
 * import { Publisher, layer } from "publish-internal"
 *
 * const program = Effect.gen(function*() {
 *   const publisher = yield* Publisher
 *   return yield* publisher.publish({ all: true, since: "origin/main" })
 * }).pipe(Effect.provide(layer), Effect.provide(BunServices.layer))
 * ```
 *
 * Prefer promises? See `publish-internal/bun`.
 */
export * from "./errors.ts"
export { Exec } from "./Exec.ts"
export { Git } from "./Git.ts"
export { internalDependencies, topologicalSort, withDependents } from "./Graph.ts"
export { layer } from "./layer.ts"
export {
  type Plan,
  type PlannedPackage,
  type PublishOptions,
  Publisher,
  type PublishResult
} from "./Publisher.ts"
export { type Client, Registry, type RegistryTarget } from "./Registry.ts"
export { resolveSpecifier, rewriteManifest } from "./Rewrite.ts"
export { DEFAULT_TEMPLATE, nextBuildNumber, nextVersion, renderVersion, sanitize } from "./Version.ts"
export { type Catalogs, Workspace, type WorkspaceInfo, type WorkspacePackage } from "./Workspace.ts"
