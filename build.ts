/**
 * Build script: bundle the plugin into dist/index.js with tsc declarations.
 */
import { $ } from "bun";

// Clean
await $`rm -rf dist`;

// Bundle with bun (single-file ESM, externalize peer deps)
await $`bun build src/index.ts --outdir dist --target node --format esm --external "@opencode-ai/*" --external "fs" --external "path" --external "os" --minify`;

// Generate .d.ts
await $`bunx tsc --emitDeclarationOnly --outDir dist`;

console.log("Build complete: dist/index.js + dist/index.d.ts");
