import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
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
    assert.deepEqual(await resolver({ url }), { icons: [], selected: "" });
});

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M0 0h16v16H0z"/></svg>';
function transport(routes, addresses) {
  const requests = [],
    lookups = [];
  return {
    requests,
    lookups,
    lookup: async (hostname) => {
      lookups.push(hostname);
      return (
        addresses?.(hostname, lookups.length) ?? [
          {
            address: isIP(hostname) ? hostname : "8.8.8.8",
            family: isIP(hostname) || 4,
          },
        ]
      );
    },
    request: (url, options, callback) => {
      requests.push(url.href);
      const request = new EventEmitter();
      request.end = () => {
        queueMicrotask(() => {
          if (options.signal.aborted)
            return request.emit("error", options.signal.reason);
          options.lookup(url.hostname, { all: true }, (error, values) => {
            assert.equal(error, null);
            assert.ok(values.every(({ address }) => isPublicAddress(address)));
          });
          const route = routes[url.pathname + url.search] ?? {},
            response = Readable.from([Buffer.from(route.body ?? "")]);
          response.statusCode = route.status ?? 404;
          response.headers = {
            "content-type": route.type ?? "text/html",
            ...(route.location ? { location: route.location } : {}),
          };
          const abort = () => response.destroy(options.signal.reason);
          options.signal.addEventListener("abort", abort, { once: true });
          response.once("close", () =>
            options.signal.removeEventListener("abort", abort),
          );
          callback(response);
        });
      };
      return request;
    },
  };
}

test("discovers candidates once and selects a real image rather than a missing link or HTML shell", async () => {
  const network = transport({
    "/": {
      status: 200,
      body: '<link rel="icon" href="/missing.ico"><link rel="icon" href="/shell.png"><link rel="icon" href="/brand.svg?v=2#mark">',
    },
    "/shell.png": {
      status: 200,
      type: "image/png",
      body: "<html>SPA fallback</html>",
    },
    "/brand.svg?v=2": {
      status: 200,
      type: "image/svg+xml; charset=utf-8",
      body: svg,
    },
  });
  const result = await createIconResolver(network)({
    url: "https://relay.example",
  });
  assert.equal(result.selected, "https://relay.example/brand.svg?v=2");
  assert.deepEqual(result.icons.slice(0, 3), [
    "https://relay.example/missing.ico",
    "https://relay.example/shell.png",
    "https://relay.example/brand.svg?v=2",
  ]);
  assert.deepEqual(network.requests, [
    "https://relay.example/",
    "https://relay.example/missing.ico",
    "https://relay.example/shell.png",
    "https://relay.example/brand.svg?v=2",
  ]);
});

test("tries common favicon locations under both the site prefix and the origin", async () => {
  const network = transport({
    "/panel": { status: 403 },
    "/favicon.png": {
      status: 200,
      type: "application/octet-stream",
      body: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    },
  });
  const result = await createIconResolver(network)({
    url: "https://relay.example/panel",
  });
  assert.equal(result.selected, "https://relay.example/favicon.png");
  assert.ok(result.icons.includes("https://relay.example/panel/favicon.ico"));
  assert.ok(
    result.icons.includes("https://relay.example/apple-touch-icon.png"),
  );
  assert.ok(result.icons.length <= 12);
});

test("revalidates redirects and DNS while refusing private targets and off-origin icon redirects", async () => {
  const redirect = transport({
    "/": { status: 302, location: "http://127.0.0.1/private" },
  });
  const result = await createIconResolver(redirect)({
    url: "https://relay.example",
  });
  assert.equal(result.selected, "");
  assert.ok(!redirect.requests.some((value) => value.includes("127.0.0.1")));

  const rebinding = transport(
    { "/": { status: 200, body: '<link rel="icon" href="/brand.svg">' } },
    (_hostname, count) => [
      { address: count === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 },
    ],
  );
  assert.equal(
    (await createIconResolver(rebinding)({ url: "https://relay.example" }))
      .selected,
    "",
  );
  assert.deepEqual(rebinding.requests, ["https://relay.example/"]);

  const external = transport({
    "/": { status: 200, body: '<link rel="icon" href="/brand.svg">' },
    "/brand.svg": { status: 302, location: "https://tracker.example/icon.svg" },
    "/favicon.svg": { status: 200, type: "image/svg+xml", body: svg },
  });
  assert.equal(
    (await createIconResolver(external)({ url: "https://relay.example" }))
      .selected,
    "https://relay.example/favicon.svg",
  );
  assert.ok(!external.lookups.includes("tracker.example"));
});

test("rejects oversized images and selects the next usable candidate", async () => {
  const network = transport({
    "/": {
      status: 200,
      body: '<link rel="icon" href="/large.svg"><link rel="icon" href="/small.svg">',
    },
    "/large.svg": {
      status: 200,
      type: "image/svg+xml",
      body: svg + " ".repeat(1 << 20),
    },
    "/small.svg": { status: 200, type: "image/svg+xml", body: svg },
  });
  const result = await createIconResolver(network)({
    url: "https://relay.example",
  });
  assert.equal(result.selected, "https://relay.example/small.svg");
});

test("real HTTP redirects retain the advertised favicon address", async (t) => {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<link rel="icon" href="/redirect.svg">');
    } else if (req.url === "/redirect.svg") {
      res.writeHead(302, { Location: "/brand.svg" });
      res.end("Redirecting");
    } else {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(svg);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const resolver = createIconResolver({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    // Route the transport to the synthetic fixture, not a real public provider.
    request: (url, options, callback) =>
      httpRequest(
        `http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`,
        { ...options, lookup: undefined },
        callback,
      ),
  });
  assert.equal(
    (await resolver({ url: "https://relay.example" })).selected,
    "https://relay.example/redirect.svg",
  );
  assert.deepEqual(paths, ["/", "/redirect.svg", "/brand.svg"]);
});

test("the discovery deadline also bounds a stalled DNS lookup", async (t) => {
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", () => timeout.call(AbortSignal, 20));
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const resolver = createIconResolver({
      lookup: () => new Promise(() => {}),
      request: () => {
        throw new Error("DNS did not finish");
      },
    });
    assert.deepEqual(await resolver({ url: "https://relay.example" }), {
      icons: [],
      selected: "",
    });
  } finally {
    clearTimeout(keepAlive);
  }
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
