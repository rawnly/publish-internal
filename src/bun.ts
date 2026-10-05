/** Promise-based convenience API for non-Effect users (Bun runtime). */
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { layer } from "./layer.ts"
import { type Plan, type PublishOptions, Publisher, type PublishResult } from "./Publisher.ts"

export const BunLive = layer.pipe(Layer.provideMerge(BunServices.layer))

export const planInternal = (options: PublishOptions = {}): Promise<Plan> =>
  Effect.runPromise(Publisher.use((p) => p.plan(options)).pipe(Effect.provide(BunLive)))

export const publishInternal = (options: PublishOptions = {}): Promise<ReadonlyArray<PublishResult>> =>
  Effect.runPromise(Publisher.use((p) => p.publish(options)).pipe(Effect.provide(BunLive)))

export * from "./index.ts"
