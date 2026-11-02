import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPublicAddress,
  findIcons,
  createIconResolver,
} from "../server/icons.mjs";

test("icon discovery rejects private, metadata, mapped and reserved IP addresses", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "0.0.0.0",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "192.0.0.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.1.1.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2001:0000::1",
    "2002:7f00:1::",
    "3fff::1",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(isPublicAddress(ip), true, ip);
  const resolver = createIconResolver();
  for (const url of [
    "http://127.0.0.1",
    "http://169.254.169.254",
    "file:///etc/passwd",
    "https://user:password@relay.example",
    "https://1.1.1.1:8443",
  ])
    assert.deepEqual(await resolver({ url }), { icons: [] });
});
test("reads relative icon links, rejects external trackers, deduplicates and bounds candidates", () => {
  const html = `<link href='/brand.svg' rel='icon'><link rel="shortcut icon" href="icon.png"><link rel=apple-touch-icon href=apple.png><link rel=icon href="https://tracker.example/pixel"><link rel=stylesheet href=style.css><link rel=icon href='/brand.svg'>`;
  assert.deepEqual(findIcons(html, "https://relay.example/app/"), [
    "https://relay.example/brand.svg",
    "https://relay.example/app/icon.png",
    "https://relay.example/app/apple.png",
  ]);
  assert.deepEqual(
    findIcons(
      '<link rel="icon" href="icon.png">',
      "https://relay.example/app/index.html",
    ),
    ["https://relay.example/app/icon.png"],
  );
});
