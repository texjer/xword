import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

/**
 * The portable libs (`patternGenerator`, `symmetry`, `gridUtils`, `puzExport`,
 * `alphabet`, the grid codec) are the web constructor's own code, vendored
 * into `lib/` by `scripts/sync-upstream.sh`. They keep their upstream `@/lib`
 * import paths so the copies stay byte-identical; the alias resolves them here.
 *
 * esbuild honours tsconfig `paths`, but the d.ts roll-up resolves independently,
 * so the alias is declared in both places.
 */
const frontendLib = fileURLToPath(new URL("./lib", import.meta.url));

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    mcp: "src/mcp.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  esbuildOptions(options) {
    options.alias = { ...options.alias, "@/lib": frontendLib };
  },
});
