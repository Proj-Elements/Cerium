import {
  copyFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";

for (const name of readdirSync("src/assets")) {
  if (name.startsWith("LICENSE."))
    copyFileSync(`src/assets/${name}`, `dist/assets/${name}.txt`);
}

for (const name of readdirSync("dist/assets")) {
  if (!/\.(js|css)$/.test(name)) continue;
  const path = `dist/assets/${name}`;
  writeFileSync(`${path}.gz`, gzipSync(readFileSync(path), { level: 9 }));
}
