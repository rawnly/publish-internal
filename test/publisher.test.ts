import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Exec } from "../src/Exec.ts"
import { Git } from "../src/Git.ts"
import { Publisher } from "../src/Publisher.ts"
import { Registry } from "../src/Registry.ts"
import { Workspace } from "../src/Workspace.ts"

const write = (p: string, v: unknown) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n") }

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-"))
  write(join(root, "package.json"), { name: "root", private: true, workspaces: { packages: ["packages/*"], catalog: { zod: "^3.0.0" } } })
  write(join(root, "packages/core/package.json"), { name: "core", version: "1.0.0", dependencies: { zod: "catalog:" } })
  write(join(root, "packages/ui/package.json"), { name: "ui", version: "2.0.0", dependencies: { core: "workspace:^" } })
  return root
}

test("publishes in dependency order with rewritten manifests, then restores them", async () => {
  const root = setup()
  const published: Array<{ name: string; manifest: any; tag: string }> = []

  const FakeGit = Layer.succeed(Git, Git.of({
    sha: () => Effect.succeed("abc1234"),
    branch: () => Effect.succeed("main"),
    isClean: () => Effect.succeed(true),
    changedSince: () => Effect.succeed([])
  }))
  const FakeRegistry = Layer.succeed(Registry, Registry.of({
    target: (o) => Effect.succeed({ registry: o.registry, userconfig: undefined }),
    versions: (name) => Effect.succeed(name === "core" ? ["1.0.0-internal.abc1234.0", "1.0.0-internal.abc1234.1"] : []),
    publish: (a) => Effect.sync(() => {
      const manifest = JSON.parse(readFileSync(join(a.dir, "package.json"), "utf8"))
      published.push({ name: manifest.name, manifest, tag: a.tag })
      return ""
    })
  }))
  const FakeExec = Layer.succeed(Exec, Exec.of({ run: () => Effect.die("unused"), ok: () => Effect.die("unused") }))

  const layer = Publisher.layer.pipe(
    Layer.provide(Layer.mergeAll(Workspace.layer, FakeGit, FakeRegistry, FakeExec)),
    Layer.provide(BunServices.layer)
  )

  const before = readFileSync(join(root, "packages/ui/package.json"), "utf8")
  const results = await Effect.runPromise(
    Publisher.use((p) => p.publish({ cwd: root, all: true })).pipe(Effect.provide(layer), Effect.provide(BunServices.layer))
  )

  expect(results.map((r) => r.version)).toEqual(["1.0.0-internal.abc1234.2", "2.0.0-internal.abc1234.0"])
  expect(published.map((p) => p.name)).toEqual(["core", "ui"])
  expect(published[0]!.manifest.dependencies.zod).toBe("^3.0.0")
  expect(published[1]!.manifest.dependencies.core).toBe("^1.0.0-internal.abc1234.2")
  expect(published.every((p) => p.tag === "internal")).toBe(true)
  expect(readFileSync(join(root, "packages/ui/package.json"), "utf8")).toBe(before)
})
