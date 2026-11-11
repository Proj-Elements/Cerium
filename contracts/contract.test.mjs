import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertWireContract, canonicalSiteURL } from "../web/server/contracts.generated.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url)));
for (const fixture of fixtures.cases) {
  test(`shared contract: ${fixture.name}`, () => {
    const value = structuredClone(fixtures.bases[fixture.base]);
    if (fixture.path) {
      const parent = fixture.path.slice(0, -1).reduce((object, key) => object[key], value);
      const key = fixture.path.at(-1);
      if (fixture.delete) delete parent[key];
      else if (fixture.repeat !== undefined) parent[key] = fixture.repeat.repeat(fixture.count);
      else if (Object.hasOwn(fixture, "arrayRepeat")) parent[key] = Array.from({ length: fixture.count }, () => structuredClone(fixture.arrayRepeat));
      else parent[key] = fixture.value;
    }
    if (fixture.valid) assert.doesNotThrow(() => assertWireContract(fixture.contract, value));
    else assert.throws(() => assertWireContract(fixture.contract, value), /Invalid wire contract/);
  });
}

for (const fixture of fixtures.urls) {
  test(`shared canonical URL: ${fixture.input}`, () => {
    if (fixture.valid === false) assert.throws(() => canonicalSiteURL(fixture.input), /Invalid wire contract/);
    else assert.equal(canonicalSiteURL(fixture.input), fixture.expected);
  });
}
