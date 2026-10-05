import { DependencyCycle } from "./errors.ts"
import type { WorkspacePackage } from "./Workspace.ts"

/** Names of workspace packages that `pkg` needs at runtime (prod/optional/peer). */
export const internalDependencies = (
  pkg: WorkspacePackage,
  byName: ReadonlyMap<string, WorkspacePackage>
): ReadonlyArray<string> => pkg.runtimeDependencies.filter((d) => byName.has(d) && d !== pkg.name)

/** `seeds` plus everything that (transitively) depends on them. */
export const withDependents = (
  all: ReadonlyArray<WorkspacePackage>,
  seeds: ReadonlyArray<WorkspacePackage>
): ReadonlyArray<WorkspacePackage> => {
  const byName = new Map(all.map((p) => [p.name, p]))
  const result = new Set(seeds.map((p) => p.name))
  let grew = true
  while (grew) {
    grew = false
    for (const pkg of all) {
      if (result.has(pkg.name)) continue
      if (internalDependencies(pkg, byName).some((d) => result.has(d))) {
        result.add(pkg.name)
        grew = true
      }
    }
  }
  return all.filter((p) => result.has(p.name))
}

/**
 * Dependencies-first ordering of `selected`. Only edges inside the selection
 * matter. Stable: ties are broken by name.
 */
export const topologicalSort = (
  selected: ReadonlyArray<WorkspacePackage>
): readonly [ReadonlyArray<WorkspacePackage>, DependencyCycle | undefined] => {
  const byName = new Map(selected.map((p) => [p.name, p]))
  const sorted: Array<WorkspacePackage> = []
  const state = new Map<string, "visiting" | "done">()
  const stack: Array<string> = []
  let cycle: DependencyCycle | undefined

  const visit = (pkg: WorkspacePackage): void => {
    const s = state.get(pkg.name)
    if (s === "done" || cycle) return
    if (s === "visiting") {
      const from = stack.indexOf(pkg.name)
      cycle = new DependencyCycle({ packages: [...stack.slice(from), pkg.name] })
      return
    }
    state.set(pkg.name, "visiting")
    stack.push(pkg.name)
    for (const dep of [...internalDependencies(pkg, byName)].sort()) visit(byName.get(dep)!)
    stack.pop()
    state.set(pkg.name, "done")
    sorted.push(pkg)
  }

  for (const pkg of [...selected].sort((a, b) => a.name.localeCompare(b.name))) visit(pkg)
  return [sorted, cycle]
}
