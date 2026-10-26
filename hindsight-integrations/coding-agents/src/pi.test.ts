import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const build = (contents: string) =>
  buildSync({
    stdin: { contents, resolveDir: cwd, sourcefile: "pi-bundle-test.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    metafile: true,
  });

describe("bundled Pi host version gate", () => {
  it("keeps both SDK candidates as literal dynamic external imports for Pi-Bolt", () => {
    const built = build('export * from "./src/pi";');
    const imports = Object.values(built.metafile.outputs).flatMap((output) => output.imports);
    for (const path of ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]) {
      expect(imports).toContainEqual(
        expect.objectContaining({ path, kind: "dynamic-import", external: true })
      );
    }
    expect(
      imports
        .filter((i) => i.path.endsWith("/pi-coding-agent"))
        .every((i) => i.kind === "dynamic-import")
    ).toBe(true);
  });

  it.each([
    "@earendil-works/pi-coding-agent",
    "@mariozechner/pi-coding-agent",
    "unrelated-package",
  ])("prefers validated executable metadata without loading an SDK (%s)", (name) => {
    const built = build(`
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { hostPiVersion } from "./src/pi";
      const original = fs.readFileSync;
      process.env.PI_PACKAGE_DIR = "/virtual/pi";
      fs.readFileSync = (path, ...args) => path === "/virtual/pi/package.json"
        ? JSON.stringify({ name: ${JSON.stringify(name)}, version: "1.4.0" }) : original(path, ...args);
      syncBuiltinESMExports();
      console.log(JSON.stringify({ version: await hostPiVersion() }));
    `);
    const source = built.outputFiles[0].text
      .replaceAll(
        'import("@earendil-works/pi-coding-agent")',
        'import("@hindsight-missing/pi-new")'
      )
      .replaceAll('import("@mariozechner/pi-coding-agent")', 'import("@hindsight-missing/pi-old")');
    const result = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module"], {
        cwd,
        input: source,
        encoding: "utf8",
      }).trim()
    );
    expect(result).toEqual(name === "unrelated-package" ? {} : { version: "1.4.0" });
  });

  it.each([false, true])(
    "loads without either SDK and chooses legacy unless the API provides a version (API=%s)",
    (apiVersion) => {
      const built = build(`
      import extension, { hostPiVersion } from "./src/pi";
      import { createPiHooks } from "./src/harness/pi-extension";
      const version = await hostPiVersion(${apiVersion ? '{ version: "1.4.0" }' : "undefined"});
      const core = { onPrompt: async () => {}, getInjection: () => "LEGACY", getSystemGuidance: () => "STABLE", recallForPrompt: async () => "RECALL" };
      const sections = {};
      const result = await createPiHooks(core, "pi", undefined, version).beforeAgentStart({ prompt: "goal", systemPrompt: "Pi", systemPromptOptions: { sections } }, "s", []);
      console.log(JSON.stringify({ factory: typeof extension, version, section: sections.hindsight, recall: result?.message?.content }));
    `);
      // Force both names to be unresolvable even on a developer machine with either SDK installed.
      const source = built.outputFiles[0].text
        .replaceAll("@earendil-works/pi-coding-agent", "@hindsight-missing/pi-new")
        .replaceAll("@mariozechner/pi-coding-agent", "@hindsight-missing/pi-old");
      const result = JSON.parse(
        execFileSync(process.execPath, ["--input-type=module"], {
          cwd,
          input: source,
          encoding: "utf8",
        }).trim()
      );
      expect(result).toEqual(
        apiVersion
          ? { factory: "function", version: "1.4.0", section: "STABLE", recall: "RECALL" }
          : { factory: "function", recall: "LEGACY" }
      );
    }
  );
});
