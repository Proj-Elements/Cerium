import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrigin, validOrigin } from "../server/origin.mjs";

test("loopback aliases require the same protocol, port and actual Host", () => {
  const config = parseOrigin("http://localhost:3080/");
  for (const host of ["localhost:3080", "127.0.0.1:3080", "[::1]:3080"]) {
    assert.equal(validOrigin(`http://${host}`, host, config, false), true);
  }
  for (const [origin, host] of [
    ["http://evil.example:3080", "127.0.0.1:3080"],
    ["http://127.0.0.1:3081", "127.0.0.1:3081"],
    ["https://127.0.0.1:3080", "127.0.0.1:3080"],
    ["http://127.0.0.1:3080", "evil.example:3080"],
    ["http://127.0.0.1:3080", "localhost:3080"],
    ["null", "localhost:3080"],
    [undefined, "localhost:3080"],
  ])
    assert.equal(validOrigin(origin, host, config, false), false);
});

test("public origin remains strict and supports an internal reverse-proxy Host", () => {
  const config = parseOrigin("https://cerium.example");
  assert.equal(
    validOrigin("https://cerium.example", "web:3000", config, true),
    true,
  );
  assert.equal(
    validOrigin("http://127.0.0.1:3080", "127.0.0.1:3080", config, false),
    false,
  );
  assert.equal(
    validOrigin("https://evil.example", "evil.example", config, true),
    false,
  );
});

test("unconfigured origin follows the direct Host and invalid configuration fails closed", () => {
  assert.equal(
    validOrigin("http://127.0.0.1:3080", "127.0.0.1:3080", null, false),
    true,
  );
  assert.equal(
    validOrigin("https://evil.example", "localhost:3080", null, false),
    false,
  );
  for (const value of [
    "null",
    "ftp://localhost",
    "http://user:pass@localhost",
    "https://site.example/path",
    "https://site.example?q=1",
  ])
    assert.equal(parseOrigin(value), null);
});
