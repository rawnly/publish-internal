import { expect, test } from "bun:test"
import { topologicalSort, withDependents } from "../src/Graph.ts"
import { rewriteManifest } from "../src/Rewrite.ts"
import { DEFAULT_TEMPLATE, nextVersion, unknownPlaceholders } from "../src/Version.ts"
import type { WorkspacePackage } from "../src/Workspace.ts"

const pkg = (name: string, deps: Array<string> = []): WorkspacePackage => ({
  name, version: "1.0.0", private: false, dir: `/r/${name}`, relDir: name,
  manifestPath: `/r/${name}/package.json`, rawText: "{}", raw: {}, runtimeDependencies: deps
})

const vars = { version: "1.2.3", tag: "internal", sha: "abc1234" }

test("version: first build is 0, then increments past existing", () => {
  expect(nextVersion(DEFAULT_TEMPLATE, vars, [])).toBe("1.2.3-internal.abc1234.0")
  expect(nextVersion(DEFAULT_TEMPLATE, vars, ["1.2.3-internal.abc1234.0", "1.2.3-internal.abc1234.4", "1.2.3-internal.other.9"]))
    .toBe("1.2.3-internal.abc1234.5")
})

test("version: custom template, no counter, unknown placeholders", () => {
  expect(nextVersion("{version}-pr.{sha}", vars, [])).toBe("1.2.3-pr.abc1234")
  expect(unknownPlaceholders("{version}-{nope}")).toEqual(["nope"])
})

test("graph: dependencies first, cycles detected, dependents included", () => {
  const a = pkg("a"), b = pkg("b", ["a"]), c = pkg("c", ["b"]), d = pkg("d")
  expect(topologicalSort([c, d, b, a])[0].map((p) => p.name)).toEqual(["a", "b", "c", "d"])
  expect(topologicalSort([pkg("x", ["y"]), pkg("y", ["x"])])[1]?._tag).toBe("DependencyCycle")
  expect(withDependents([a, b, c, d], [a]).map((p) => p.name)).toEqual(["a", "b", "c"])
})

test("rewrite: workspace:, catalog: and errors", () => {
  const { manifest, errors } = rewriteManifest(
    { name: "ui", dependencies: { core: "workspace:^", util: "workspace:*", zod: "catalog:", react: "catalog:react18", lodash: "^4" } },
    {
      version: "1.0.0-internal.x.0",
      workspaceVersions: new Map([["core", "2.0.0-internal.x.0"], ["util", "0.1.0"]]),
      catalogs: { default: { zod: "^3.0.0" }, named: { react18: { react: "^18.2.0" } } }
    }
  )
  expect(errors).toEqual([])
  expect(manifest.version).toBe("1.0.0-internal.x.0")
  expect(manifest.dependencies).toEqual({
    core: "^2.0.0-internal.x.0", util: "0.1.0", zod: "^3.0.0", react: "^18.2.0", lodash: "^4"
  })
  expect(rewriteManifest({ dependencies: { zod: "catalog:" } }, {
    version: "1", workspaceVersions: new Map(), catalogs: { default: {}, named: {} }
  }).errors.length).toBe(1)
})
