#!/usr/bin/env bun

// Description: Publishes a package with an internal version
//
// Usage: @satispay/scripts publish-internal [--path=<base-path>] [package-directory]
//
// Arguments:
//   [package-directory]    Package folder name (optional; defaults to current directory)
//
// Options:
//   --path=<base-path>     Base path prefix (default: ./packages/)
//
// Examples:
//   publish-internal              # Non-monorepo: uses ./package.json
//   publish-internal ui           # Monorepo: uses ./packages/ui/package.json
//   publish-internal --path=./libs ui

import { $ } from "bun";
import { existsSync } from "fs";
import { createInterface } from "readline";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

// --- Parse arguments ---
const args = process.argv.slice(2);
let basePath = "./packages/";
let packageArg = "";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--path" && args[i + 1]) {
    basePath = args[++i];
  } else if (arg.startsWith("--path=")) {
    basePath = arg.slice("--path=".length);
  } else if (arg === "--help" || arg === "-h") {
    console.log("Usage: publish-internal [--path=<base-path>] [package-directory]");
    process.exit(0);
  } else if (!arg.startsWith("-")) {
    packageArg = arg;
  }
}

// --- Resolve package path ---
let packagePath: string;

if (packageArg) {
  const dir = packageArg.replace(/^@[^/]+\//, ""); // strip any @scope/ prefix
  if (!basePath.endsWith("/")) basePath += "/";
  packagePath = `${basePath}${dir}`;
} else {
  packagePath = ".";
}

const manifest = `${packagePath}/package.json`;

if (!existsSync(manifest)) {
  console.error(`Error: Package manifest not found at ${manifest}`);
  process.exit(1);
}

// --- Read package metadata ---
const pkg = await Bun.file(manifest).json();
const currentVersion: string = pkg.version;
const fullPackageName: string = pkg.name;

if (!fullPackageName) {
  console.error("Error: package.json is missing a \"name\" field");
  process.exit(1);
}

// --- Build version string ---
const commitHash = (await $`git rev-parse --short HEAD`.text()).trim();
const baseVersion = `${currentVersion}-internal.${commitHash}`;

console.log("NOTE: Remember to build your package before publishing.");
await Bun.sleep(2000);

// --- Warn on unclean working directory ---
const gitDiff = await $`git diff-index --quiet HEAD --`.quiet().nothrow();
if (gitDiff.exitCode !== 0) {
  console.warn(`${YELLOW}Warning${RESET}: Unclean working directory detected.`);
  console.warn("Proceeding with publish may lead to unexpected results.");
  const choice = await prompt("Do you want to continue? (y/n) ");
  if (choice !== "y" && choice !== "") process.exit(1);
}

// --- Determine next build number ---
let buildNumber = 0;
// npm view exits non-zero when the package has no "latest" dist-tag (e.g. only "internal" tags),
// so we parse stdout regardless of exit code and only skip on a true 404.
const viewResult = await $`npm view ${fullPackageName} versions --json`.quiet().nothrow();
const isNotFound = viewResult.stderr.toString().includes("E404");

if (!isNotFound) {
  try {
    const raw = viewResult.stdout.toString().trim();
    // npm view returns a bare string (not array) when there is exactly one version
    const parsed: unknown = JSON.parse(raw);
    const versions: string[] = Array.isArray(parsed) ? parsed : [parsed as string];
    const prefix = `${baseVersion}.`;

    for (const ver of versions) {
      if (ver.startsWith(prefix)) {
        const num = parseInt(ver.slice(prefix.length), 10);
        if (!isNaN(num) && num >= buildNumber) buildNumber = num + 1;
      }
    }
  } catch {
    // unparseable output — proceed with buildNumber = 0
  }
}

const version = `${baseVersion}.${buildNumber}`;

// --- Publish ---
process.chdir(packagePath);

await $`npm version ${version} --no-workspace-update --no-git-tag-version`;

const publishResult = await $`npm publish --no-git-checks --tag internal`.nothrow();

if (publishResult.exitCode !== 0) {
  await $`npm version ${currentVersion} --no-workspace-update --no-git-tag-version`.nothrow();
  await $`npm run lint:fix-quiet --if-present`.nothrow();
  process.exit(1);
}

await $`npm version ${currentVersion} --no-workspace-update --no-git-tag-version`;
await $`npm run lint:fix-quiet --if-present`.nothrow();

console.log(`Package ${fullPackageName} published with version ${version}`);
