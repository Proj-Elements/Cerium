import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactDigest, installPremium } from "../scripts/install-premium.mjs";

const require = createRequire(
  new URL("../build-tools/package.json", import.meta.url),
);
const { c: archive } = require("tar");

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "cerium-premium-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "source/package");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await mkdir(join(root, "node_modules/@heroui-pro/react"), {
    recursive: true,
  });
  const identity = { name: "@heroui-pro/react", version: "1.0.0-beta.11" };
  await writeFile(join(packageRoot, "package.json"), JSON.stringify(identity));
  await writeFile(
    join(packageRoot, "dist/index.js"),
    "export const fixture = true;\n",
  );
  for (const name of ["LICENSE", "README.md"]) {
    await writeFile(join(packageRoot, name), "Locked npm metadata\n");
    await writeFile(
      join(root, "node_modules/@heroui-pro/react", name),
      "Locked npm metadata\n",
    );
  }
  await writeFile(join(root, "node_modules/@heroui-pro/react/existing"), "old");
  await writeFile(join(root, "package.json"), '{"dependencies":{}}\n');
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      packages: { [`node_modules/${identity.name}`]: identity },
    }),
  );
  const expected = { ...identity, sha256: await artifactDigest(packageRoot) };
  const chunks = [];
  for await (const chunk of archive(
    {
      cwd: join(root, "source"),
      gzip: true,
      filter: (entryPath) => !/\/(?:LICENSE|README\.md)$/.test(entryPath),
    },
    ["package"],
  ))
    chunks.push(chunk);
  return { root, expected, bytes: Buffer.concat(chunks) };
}

test("premium installation keeps the application lock and dependency declarations intact", async (context) => {
  const { root, expected, bytes } = await fixture(context);
  const manifest = await readFile(join(root, "package.json"), "utf8");
  const lock = await readFile(join(root, "package-lock.json"), "utf8");
  const token = "hp_1234abcd";
  await installPremium({
    root,
    expected,
    token,
    fetchImpl: async (url, options) => {
      assert.equal(url.origin, "https://hpsetup-cdn.932324.xyz");
      assert.equal(url.pathname, "/api/tarball/react/1.0.0-beta.11");
      assert.equal(url.searchParams.get("key"), token);
      assert.equal(options.redirect, "error");
      return new Response(bytes);
    },
  });
  assert.equal(await readFile(join(root, "package.json"), "utf8"), manifest);
  assert.equal(await readFile(join(root, "package-lock.json"), "utf8"), lock);
  assert.equal(
    await readFile(
      join(root, "node_modules/@heroui-pro/react/dist/index.js"),
      "utf8",
    ),
    "export const fixture = true;\n",
  );
  assert.equal(
    await readFile(
      join(root, "node_modules/@heroui-pro/react/LICENSE"),
      "utf8",
    ),
    "Locked npm metadata\n",
  );
});

test("tampered premium content never replaces the existing installation", async (context) => {
  const { root, expected, bytes } = await fixture(context);
  await assert.rejects(
    installPremium({
      root,
      expected: { ...expected, sha256: "0".repeat(64) },
      token: "hp_1234abcd",
      fetchImpl: async () => new Response(bytes),
    }),
    /integrity verification failed/,
  );
  assert.equal(
    await readFile(
      join(root, "node_modules/@heroui-pro/react/existing"),
      "utf8",
    ),
    "old",
  );
});

test("download failures do not echo the authenticated URL", async (context) => {
  const { root, expected } = await fixture(context);
  const token = "hp_1234abcd";
  await assert.rejects(
    installPremium({
      root,
      expected,
      token,
      fetchImpl: async (url) => {
        throw new Error(String(url));
      },
    }),
    (error) =>
      error.message === "Premium artifact download failed" &&
      !error.message.includes(token),
  );
});

test("a stale premium artifact pin fails before making an authenticated request", async (context) => {
  const { root, expected } = await fixture(context);
  await assert.rejects(
    installPremium({
      root,
      expected: { ...expected, version: "different" },
      token: "hp_1234abcd",
      fetchImpl: () => {
        assert.fail("stale artifact pins must not download");
      },
    }),
    /differs from the application lock/,
  );
});
