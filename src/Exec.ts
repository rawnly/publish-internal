import { Context, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { CommandError } from "./errors.ts"

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface ExecOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
}

/** Thin, mockable process runner. `run` never fails on a non-zero exit code. */
export class Exec extends Context.Service<Exec, {
  run(command: string, args: ReadonlyArray<string>, options?: ExecOptions): Effect.Effect<ExecResult, CommandError>
  /** Like `run` but fails with CommandError on a non-zero exit code. */
  ok(command: string, args: ReadonlyArray<string>, options?: ExecOptions): Effect.Effect<ExecResult, CommandError>
}>()("publish-internal/Exec") {
  static readonly layer = Layer.effect(
    Exec,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const run = (command: string, args: ReadonlyArray<string>, options?: ExecOptions) =>
        Effect.scoped(
          Effect.gen(function*() {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, [...args], {
                cwd: options?.cwd,
                env: options?.env,
                extendEnv: true
              })
            )
            const [stdout, stderr, exitCode] = yield* Effect.all([
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode
            ], { concurrency: "unbounded" })
            return { stdout, stderr, exitCode: Number(exitCode) } satisfies ExecResult
          })
        ).pipe(
          Effect.mapError((cause) =>
            new CommandError({ command: [command, ...args].join(" "), exitCode: -1, stderr: String(cause) })
          ),
          Effect.withSpan("Exec.run", { attributes: { command, args: args.join(" ") } })
        )

      const ok = (command: string, args: ReadonlyArray<string>, options?: ExecOptions) =>
        run(command, args, options).pipe(
          Effect.flatMap((r) =>
            r.exitCode === 0
              ? Effect.succeed(r)
              : Effect.fail(
                new CommandError({
                  command: [command, ...args].join(" "),
                  exitCode: r.exitCode,
                  stderr: r.stderr.trim() || r.stdout.trim()
                })
              )
          )
        )

      return Exec.of({ run, ok })
    })
  )
}
