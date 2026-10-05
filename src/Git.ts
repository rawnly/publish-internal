import { Context, Effect, Layer, Path } from "effect"
import { CommandError } from "./errors.ts"
import { Exec } from "./Exec.ts"

export class Git extends Context.Service<Git, {
  sha(cwd: string): Effect.Effect<string, CommandError>
  branch(cwd: string): Effect.Effect<string, CommandError>
  isClean(cwd: string): Effect.Effect<boolean, CommandError>
  /** Absolute paths changed between `ref` and the working tree (committed + uncommitted + untracked). */
  changedSince(cwd: string, ref: string): Effect.Effect<ReadonlyArray<string>, CommandError>
}>()("publish-internal/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function*() {
      const exec = yield* Exec
      const path = yield* Path.Path

      const out = (cwd: string, ...args: Array<string>) =>
        exec.ok("git", args, { cwd }).pipe(Effect.map((r) => r.stdout.trim()))

      const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean)

      return Git.of({
        sha: (cwd) =>
          out(cwd, "rev-parse", "--short", "HEAD").pipe(
            Effect.mapError((e) => new CommandError({ ...e, stderr: `${e.stderr}\nThe version template uses {sha}, which needs at least one git commit.` }))
          ),
        branch: (cwd) => out(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
        isClean: (cwd) => out(cwd, "status", "--porcelain").pipe(Effect.map((s) => s === "")),
        changedSince: Effect.fn("Git.changedSince")(function*(cwd: string, ref: string) {
          const top = yield* out(cwd, "rev-parse", "--show-toplevel")
          // three-dot = changes on this branch since the merge-base with `ref`
          const committed = yield* out(cwd, "diff", "--name-only", `${ref}...HEAD`)
          const working = yield* out(cwd, "diff", "--name-only", "HEAD")
          const untracked = yield* out(cwd, "ls-files", "--others", "--exclude-standard")
          const all = new Set([...lines(committed), ...lines(working), ...lines(untracked)])
          return [...all].map((f) => path.join(top, f))
        })
      })
    })
  )
}
