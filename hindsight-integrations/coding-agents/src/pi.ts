/**
 * pi's extension entrypoint (`pi`, npm `@earendil-works/pi-coding-agent`).
 *
 * pi loads extensions listed in the `extensions` array of `~/.pi/agent/settings.json` and calls each
 * one's default export with its `pi` API. The whole adapter lives in src/harness/pi-extension.ts,
 * shared with Prime Agent — pi's fork — which registers the same default-export shape from its own
 * settings file.
 *
 * pi has no hooks system, which is why it is a persistent-extension harness rather than a
 * hook-binary harness like claude-code/cursor/codex.
 *
 * This entry exists — rather than pointing pi at dist/prime-agent.js — purely so the harness reports
 * as "pi": that selects the `harnesses.pi` config section, feeds `{harness}` bank templating, and
 * keeps pi sessions attributable in diagnostics separately from Prime Agent's.
 */
import { createPiExtension, type ExtensionFactory } from "./harness/pi-extension";

import { diag } from "./core/diag";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HARNESS = "pi";

export async function hostPiVersion(api?: unknown): Promise<string | undefined> {
  // Current Pi exposes VERSION on its SDK, not ExtensionAPI/ExtensionContext. Prefer an explicit
  // API version when an embedding host supplies one, without evaluating the entire host SDK.
  if (api && typeof api === "object" && "version" in api && typeof api.version === "string") {
    return api.version;
  }
  // Pi's compiled binary ships package.json beside process.execPath (or PI_PACKAGE_DIR).
  // This is also the source of its exported VERSION. Native ESM dist/pi.js can bypass jiti even
  // for literal dynamic imports, so read that metadata first; never mistake our own package for Pi.
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(process.env.PI_PACKAGE_DIR || dirname(process.execPath), "package.json"),
        "utf8"
      )
    );
    if (
      (pkg.name === "@earendil-works/pi-coding-agent" ||
        pkg.name === "@mariozechner/pi-coding-agent") &&
      typeof pkg.version === "string"
    ) {
      return pkg.version;
    }
  } catch {
    /* not a packaged binary, or its metadata is unavailable */
  }
  // Literal dynamic imports are essential for jiti's host module mapping. Static imports worked
  // in built Pi-Bolt too, but crashed hosts that did not map that package name.
  // Never bundle/install a second SDK, and never let an unavailable SDK disable the extension.
  try {
    const host = await import("@earendil-works/pi-coding-agent");
    if (typeof host.VERSION === "string") return host.VERSION;
  } catch {
    /* try the pre-rename host */
  }
  try {
    const host = await import("@mariozechner/pi-coding-agent");
    if (typeof host.VERSION === "string") return host.VERSION;
  } catch {
    /* unknown hosts keep the legacy injection path */
  }
  diag(HARNESS, "pi_version_unavailable", { version: "unknown" });
  return undefined;
}

const extension: ExtensionFactory = async (pi) => {
  await createPiExtension(HARNESS, undefined, await hostPiVersion(pi))(pi);
};

export { extension };
export default extension;
