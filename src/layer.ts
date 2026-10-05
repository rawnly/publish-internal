import { Layer } from "effect"
import { Exec } from "./Exec.ts"
import { Git } from "./Git.ts"
import { Publisher } from "./Publisher.ts"
import { Registry } from "./Registry.ts"
import { Workspace } from "./Workspace.ts"

const services = Layer.mergeAll(Workspace.layer, Git.layer, Registry.layer)

/**
 * Everything except the platform. Needs `FileSystem`, `Path` and
 * `ChildProcessSpawner` (e.g. from `BunServices.layer` / `NodeServices.layer`).
 */
export const layer = Publisher.layer.pipe(
  Layer.provideMerge(services),
  Layer.provideMerge(Exec.layer)
)
