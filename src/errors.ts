import { Schema } from "effect"

export class ManifestError extends Schema.TaggedError<ManifestError>()("ManifestError", {
  path: Schema.String,
  message: Schema.String
}) {}

export class PackageNotFound extends Schema.TaggedError<PackageNotFound>()("PackageNotFound", {
  query: Schema.String,
  available: Schema.Array(Schema.String)
}) {}

export class NoPackagesSelected extends Schema.TaggedError<NoPackagesSelected>()("NoPackagesSelected", {
  message: Schema.String
}) {}

export class DependencyCycle extends Schema.TaggedError<DependencyCycle>()("DependencyCycle", {
  packages: Schema.Array(Schema.String)
}) {}

export class DirtyTree extends Schema.TaggedError<DirtyTree>()("DirtyTree", {}) {}

export class InvalidOption extends Schema.TaggedError<InvalidOption>()("InvalidOption", {
  message: Schema.String
}) {}

export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  command: Schema.String,
  exitCode: Schema.Number,
  stderr: Schema.String
}) {
  override get message() {
    return `\`${this.command}\` failed (exit ${this.exitCode}): ${this.stderr}`
  }
}

export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  message: Schema.String
}) {}

export class PublishFailed extends Schema.TaggedError<PublishFailed>()("PublishFailed", {
  name: Schema.String,
  version: Schema.String,
  message: Schema.String
}) {}

export type PublishError =
  | ManifestError
  | PackageNotFound
  | NoPackagesSelected
  | DependencyCycle
  | DirtyTree
  | InvalidOption
  | CommandError
  | RegistryError
  | PublishFailed

/** Human-friendly, single-purpose message (with a hint when we have one). */
export const describeError = (e: PublishError): string => {
  switch (e._tag) {
    case "ManifestError":
      return e.message.includes("NotFound")
        ? `No package.json found at ${e.path}`
        : `Invalid manifest ${e.path}: ${e.message}`
    case "PackageNotFound":
      return `Package "${e.query}" not found in the workspace.\n  Available: ${e.available.join(", ") || "(none)"}`
    case "NoPackagesSelected":
      return e.message
    case "DependencyCycle":
      return `Dependency cycle between selected packages: ${e.packages.join(" -> ")}`
    case "DirtyTree":
      return "Working tree has uncommitted changes.\n  Commit/stash them, or pass --allow-dirty."
    case "InvalidOption":
      return e.message
    case "CommandError":
      return `\`${e.command}\` failed (exit ${e.exitCode})${e.stderr ? `:\n${indent(e.stderr)}` : ""}`
    case "RegistryError":
      return `Registry error: ${e.message}`
    case "PublishFailed":
      return `Failed to publish ${e.name}@${e.version}:\n${indent(e.message)}\n  (package.json was restored)`
  }
}

const indent = (s: string) => s.trim().split("\n").map((l) => `  ${l}`).join("\n")
