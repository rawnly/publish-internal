/**
 * Pure helpers for building internal versions from a template.
 *
 * Placeholders: {version} {tag} {sha} {branch} {timestamp} {run} {n}
 * `{n}` is a per-registry build counter: highest existing match + 1.
 */

export const DEFAULT_TEMPLATE = "{version}-{tag}.{sha}.{n}"

export const KNOWN_PLACEHOLDERS = ["version", "tag", "sha", "branch", "timestamp", "run", "n"] as const

export type VersionVars = Readonly<Record<string, string>>

const PLACEHOLDER = /(\{\w+\})/
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Make a string safe to use as a semver prerelease identifier. */
export const sanitize = (s: string): string => s.replace(/[^0-9A-Za-z-]+/g, "-").replace(/^-+|-+$/g, "")

export const unknownPlaceholders = (template: string): ReadonlyArray<string> =>
  template
    .split(PLACEHOLDER)
    .flatMap((part) => {
      const m = /^\{(\w+)\}$/.exec(part)
      return m && !(KNOWN_PLACEHOLDERS as ReadonlyArray<string>).includes(m[1]!) ? [m[1]!] : []
    })

export const renderVersion = (template: string, vars: VersionVars, n: number): string =>
  template
    .split(PLACEHOLDER)
    .map((part) => {
      const m = /^\{(\w+)\}$/.exec(part)
      if (!m) return part
      return m[1] === "n" ? String(n) : (vars[m[1]!] ?? "")
    })
    .join("")

/** Next free build number given versions already on the registry. */
export const nextBuildNumber = (
  template: string,
  vars: VersionVars,
  existing: ReadonlyArray<string>
): number => {
  if (!template.includes("{n}")) return 0
  const source = template
    .split(PLACEHOLDER)
    .map((part) => {
      const m = /^\{(\w+)\}$/.exec(part)
      if (!m) return escapeRegExp(part)
      return m[1] === "n" ? "(\\d+)" : escapeRegExp(vars[m[1]!] ?? "")
    })
    .join("")
  const re = new RegExp(`^${source}$`)
  let next = 0
  for (const v of existing) {
    const m = re.exec(v)
    if (m) next = Math.max(next, Number(m[1]) + 1)
  }
  return next
}

export const nextVersion = (
  template: string,
  vars: VersionVars,
  existing: ReadonlyArray<string>
): string => renderVersion(template, vars, nextBuildNumber(template, vars, existing))
