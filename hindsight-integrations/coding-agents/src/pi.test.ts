import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("bundled Pi host version gate", () => {
  it("keeps the SDK as a static external import for Pi-Bolt's host module mapping", () => {
    const built = buildSync({
      entryPoints: [fileURLToPath(new URL("./pi.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      write: false,
      metafile: true,
    });
    const imports = Object.values(built.metafile.outputs).flatMap((output) => output.imports);
    // Variable dynamic import worked under source jiti but returned undefined from dist/pi.js:
    // that silently re-enabled the legacy per-turn system deltas in a real compiled Pi-Bolt run.
    expect(imports).toContainEqual(
      expect.objectContaining({
        path: "@mariozechner/pi-coding-agent",
        kind: "import-statement",
        external: true,
      })
    );
  });
});
