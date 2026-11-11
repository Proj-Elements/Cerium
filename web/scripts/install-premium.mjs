import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolsRequire = createRequire(join(webRoot, "build-tools/package.json"));
const artifact = JSON.parse(
  await readFile(join(webRoot, "build-tools/premium-artifact.json"), "utf8"),
);

/** Hash regular artifact files in path order, ignoring JSON formatting. */
export async function artifactDigest(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix + name;
      const full = join(directory, name);
      const stat = await lstat(full);
      if (stat.isDirectory()) await visit(full, relative + "/");
      else if (stat.isFile()) files.push(relative);
      else throw new Error("Premium artifact contains a non-regular file");
    }
  }
  await visit(root);
  const digest = createHash("sha256");
  for (const file of files) {
    let bytes = await readFile(join(root, file));
    if (file === "package.json") {
      const manifest = JSON.parse(bytes);
      delete manifest.scripts;
      bytes = Buffer.from(JSON.stringify(manifest));
    }
    digest.update(file + "\0");
    digest.update(createHash("sha256").update(bytes).digest());
  }
  return digest.digest("hex");
}

/** Install only the pinned premium artifact, without changing peer dependencies. */
export async function installPremium({
  token = process.env.HEROUI_SETUP_TOKEN,
  root = webRoot,
  expected = artifact,
  fetchImpl = fetch,
} = {}) {
  if (!/^hp_[0-9a-f]+$/.test(token || ""))
    throw new Error("HEROUI_SETUP_TOKEN must contain a valid installation key");
  const lock = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8"),
  );
  if (
    lock.packages?.[`node_modules/${expected.name}`]?.version !==
    expected.version
  )
    throw new Error(
      "Premium artifact version differs from the application lock",
    );
  const target = join(root, "node_modules", expected.name);
  const temporary = await mkdtemp(join(tmpdir(), "cerium-premium-"));
  try {
    for (const name of ["LICENSE", "README.md"]) {
      try {
        await cp(join(target, name), join(temporary, name));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const url = new URL(
      `https://hpsetup-cdn.932324.xyz/api/tarball/react/${expected.version}`,
    );
    url.searchParams.set("key", token);
    url.searchParams.set("ci", "1");
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new Error("Premium artifact download failed");
    }
    if (!response.ok || !response.body)
      throw new Error(
        `Premium artifact download returned HTTP ${response.status}`,
      );
    let compressedBytes = 0;
    let extractedBytes = 0;
    const compressedLimit = new Transform({
      transform(chunk, encoding, callback) {
        compressedBytes += chunk.length;
        callback(
          compressedBytes > 64 * 1024 * 1024
            ? new Error("Premium artifact download exceeds the size limit")
            : null,
          chunk,
        );
      },
    });
    const { x: extract } = toolsRequire("tar");
    await pipeline(
      Readable.fromWeb(response.body),
      compressedLimit,
      extract({
        cwd: temporary,
        strip: 1,
        strict: true,
        filter(entryPath, entry) {
          extractedBytes += entry.size || 0;
          return (
            ["File", "Directory"].includes(entry.type) &&
            !entryPath.split("/").includes("..") &&
            !entryPath.startsWith("/") &&
            extractedBytes <= 256 * 1024 * 1024
          );
        },
      }),
    );
    await rm(join(temporary, "dist/postinstall"), {
      recursive: true,
      force: true,
    });
    if ((await artifactDigest(temporary)) !== expected.sha256)
      throw new Error("Premium artifact integrity verification failed");
    const manifestFile = join(temporary, "package.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    if (
      manifest.name !== expected.name ||
      manifest.version !== expected.version
    )
      throw new Error("Premium artifact identity verification failed");
    delete manifest.scripts;
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    await rm(target, { recursive: true, force: true });
    await cp(temporary, target, { recursive: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  installPremium().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
