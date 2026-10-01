// Test-only resolver for `node --experimental-strip-types --test`.
// Desk sources use bundler-style imports ("./cache", "@/lib/utils") that Vite
// resolves but Node does not. This maps "@/..." to src/ and retries
// extensionless relative imports with ".ts" / "/index.ts".
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const SRC = ${JSON.stringify(new URL("../src/", import.meta.url).href)};
      export async function resolve(specifier, context, next) {
        let spec = specifier;
        if (spec.startsWith("@/")) spec = SRC + spec.slice(2);
        try {
          return await next(spec, context);
        } catch (err) {
          const relative = spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:");
          if (!relative || /\\.[cm]?[jt]sx?$/.test(spec)) throw err;
          for (const ext of [".ts", ".tsx", "/index.ts"]) {
            try {
              return await next(spec + ext, context);
            } catch {}
          }
          throw err;
        }
      }
    `),
);
