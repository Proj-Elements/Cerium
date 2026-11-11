import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const web = join(repository, "web");
const require = createRequire(join(web, "package.json"));
const postcss = require("postcss");
const compiler = require.resolve("typescript/package.json");
const result = spawnSync(
  process.execPath,
  [join(dirname(compiler), "bin/tsc"), "--noEmit", "--noCheck"],
  { cwd: web, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : [filename];
  });
}

const sources = files(join(web, "src"));
for (const filename of sources) {
  if (!/\.(?:css|[cm]?[jt]sx?)$/.test(filename)) continue;
  const source = readFileSync(filename, "utf8");
  if (filename.endsWith(".css")) postcss.parse(source, { from: filename });
  const imports = source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(|\bimport\s*)["'](\.[^"']+)["']/g,
  );
  for (const [, imported] of imports) {
    const target = resolve(dirname(filename), imported);
    const candidates = [
      target,
      ...[".ts", ".tsx", ".js", ".mjs", ".json"].map(
        (extension) => target + extension,
      ),
      ...[".ts", ".tsx", ".js", ".mjs"].map((extension) =>
        join(target, "index" + extension),
      ),
    ];
    if (
      !candidates.some(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      )
    )
      throw new Error(`Missing local import ${imported} in ${filename}`);
  }
}
console.log(
  "Frontend TypeScript/TSX syntax, CSS parsing and local imports passed; this is not a full typecheck, build or browser check.",
);
