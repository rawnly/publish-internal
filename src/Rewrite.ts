import type { Catalogs } from "./Workspace.ts"

export const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const

export interface RewriteInput {
  /** Version to publish this package under. */
  readonly version: string
  /** name -> version for every workspace package (planned version when selected, current otherwise). */
  readonly workspaceVersions: ReadonlyMap<string, string>
  readonly catalogs: Catalogs
}

export interface RewriteResult {
  readonly manifest: Record<string, any>
  readonly errors: ReadonlyArray<string>
}

/** Resolve one specifier. Returns the new spec, or an error string. */
export const resolveSpecifier = (
  dep: string,
  spec: string,
  input: Pick<RewriteInput, "workspaceVersions" | "catalogs">
): { readonly ok: string } | { readonly error: string } => {
  if (spec.startsWith("workspace:")) {
    const version = input.workspaceVersions.get(dep)
    if (!version) return { error: `${dep}: "${spec}" does not match any workspace package` }
    const rest = spec.slice("workspace:".length)
    if (rest === "" || rest === "*") return { ok: version }
    if (rest === "^") return { ok: `^${version}` }
    if (rest === "~") return { ok: `~${version}` }
    // workspace:../path style -> exact; workspace:^1.2.3 -> literal range
    return { ok: /^[\^~<>=\d]/.test(rest) ? rest : version }
  }
  if (spec.startsWith("catalog:")) {
    const name = spec.slice("catalog:".length)
    const catalog = name === "" || name === "default" ? input.catalogs.default : input.catalogs.named[name]
    const resolved = catalog?.[dep]
    if (!resolved) return { error: `${dep}: "${spec}" not found in ${name || "default"} catalog` }
    return { ok: resolved }
  }
  return { ok: spec }
}

/** Returns a rewritten copy of a raw manifest (never mutates the input). */
export const rewriteManifest = (raw: Record<string, any>, input: RewriteInput): RewriteResult => {
  const manifest: Record<string, any> = { ...raw, version: input.version }
  const errors: Array<string> = []

  for (const field of DEP_FIELDS) {
    const deps = raw[field] as Record<string, string> | undefined
    if (!deps) continue
    const out: Record<string, string> = {}
    for (const [dep, spec] of Object.entries(deps)) {
      const r = resolveSpecifier(dep, spec, input)
      if ("error" in r) {
        errors.push(`${field}.${r.error}`)
        out[dep] = spec
      } else {
        out[dep] = r.ok
      }
    }
    manifest[field] = out
  }
  return { manifest, errors }
}
