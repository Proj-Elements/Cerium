import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  isPublicAddress,
  findIcons,
  createIconResolver,
} from "../server/icons.mjs";
import { iconType } from "../server/icon-content.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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
            response = Readable.from(
              (async function* () {
                if (route.delay) await delay(route.delay);
                yield Buffer.from(route.body ?? "");
              })(),
            );
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
  assert.deepEqual(result.image, {
    body: Buffer.from(svg),
    type: "image/svg+xml",
  });
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
      body: png,
    },
  });
  const result = await createIconResolver(network)({
    url: "https://relay.example/panel",
  });
  assert.equal(result.selected, "https://relay.example/favicon.png");
  assert.equal(result.image.type, "image/png");
  assert.ok(result.icons.includes("https://relay.example/panel/favicon.ico"));
  assert.ok(
    result.icons.includes("https://relay.example/apple-touch-icon.png"),
  );
  assert.ok(result.icons.length <= 12);
});

test("downloads a saved selection first and rediscovers only if it is unavailable", async () => {
  const routes = {
    "/": { status: 200, body: '<link rel="icon" href="/brand.svg">' },
    "/brand.svg": { status: 200, type: "image/svg+xml", body: svg },
  };
  const cached = transport(routes);
  assert.equal(
    (
      await createIconResolver(cached)({
        url: "https://relay.example",
        preferred: "https://relay.example/brand.svg",
      })
    ).selected,
    "https://relay.example/brand.svg",
  );
  assert.deepEqual(cached.requests, ["https://relay.example/brand.svg"]);

  const stale = transport(routes);
  const input = {
    url: "https://relay.example",
    preferred: "https://relay.example/removed.svg",
  };
  assert.equal(
    (await createIconResolver(stale)(input)).selected,
    "https://relay.example/brand.svg",
  );
  assert.deepEqual(stale.requests, [
    input.preferred,
    input.url + "/",
    input.url + "/brand.svg",
  ]);

  const explicit = transport(routes);
  assert.equal(
    (await createIconResolver(explicit)({ ...input, explicit: true })).selected,
    "",
  );
  assert.deepEqual(explicit.requests, [input.preferred]);

  const privateTarget = transport(routes);
  assert.equal(
    (
      await createIconResolver(privateTarget)({
        ...input,
        preferred: "http://169.254.169.254/metadata",
        explicit: true,
      })
    ).selected,
    "",
  );
  assert.deepEqual(privateTarget.requests, []);
});

test("icon discovery tolerates a slow proxy response without losing the advertised icon", async () => {
  const network = transport({
    "/": { status: 200, body: '<link rel="icon" href="/brand.svg">' },
    "/brand.svg": {
      status: 200,
      type: "image/svg+xml",
      body: svg,
      delay: 1500,
    },
  });
  assert.equal(
    (await createIconResolver(network)({ url: "https://relay.example" }))
      .selected,
    "https://relay.example/brand.svg",
  );
});

test("Fake-IP support is opt-in for DNS names and never permits literal or other private targets", async () => {
  const routes = {
    "/": { status: 200, body: '<link rel="icon" href="/brand.svg">' },
    "/brand.svg": { status: 200, type: "image/svg+xml", body: svg },
  };
  const network = transport(routes, () => [
    { address: "198.18.0.55", family: 4 },
  ]);
  // The synthetic transport still verifies the pinned address below.
  network.request = (url, options, callback) => {
    const req = new EventEmitter();
    req.end = () =>
      queueMicrotask(() => {
        options.lookup(url.hostname, {}, (_error, address) =>
          assert.equal(address, "198.18.0.55"),
        );
        network.requests.push(url.href);
        const route = routes[url.pathname],
          response = Readable.from([Buffer.from(route?.body ?? "")]);
        response.statusCode = route?.status ?? 404;
        response.headers = {
          "content-type":
            url.pathname === "/brand.svg" ? "image/svg+xml" : "text/html",
        };
        callback(response);
      });
    return req;
  };
  assert.equal(
    (
      await createIconResolver({ ...network, allowFakeIP: false })({
        url: "https://relay.example",
      })
    ).selected,
    "",
  );
  assert.equal(
    (
      await createIconResolver({ ...network, allowFakeIP: true })({
        url: "https://relay.example",
      })
    ).selected,
    "https://relay.example/brand.svg",
  );
  network.requests.length = 0;
  const resolver = createIconResolver({ ...network, allowFakeIP: true });
  for (const url of [
    "https://198.18.0.55",
    "http://127.0.0.1",
    "http://169.254.169.254",
  ])
    assert.equal((await resolver({ url })).selected, "");
  assert.deepEqual(network.requests, []);
  const privateNetwork = transport(routes, () => [
    { address: "10.0.0.1", family: 4 },
  ]);
  assert.equal(
    (
      await createIconResolver({ ...privateNetwork, allowFakeIP: true })({
        url: "https://relay.example",
      })
    ).selected,
    "",
  );
  assert.deepEqual(privateNetwork.requests, []);
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

test("a proxy cannot re-resolve a validated hostname to a private icon origin", async (t) => {
  let privateRequests = 0;
  const privateServer = createServer((_req, res) => {
    privateRequests++;
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end(svg);
  });
  privateServer.listen(0, "127.0.0.1");
  await once(privateServer, "listening");
  t.after(() => new Promise((resolve) => privateServer.close(resolve)));
  const targets = [],
    proxy = createServer((req, res) => {
      // Simulate a different DNS view at the proxy without touching real services.
      const upstream = httpRequest(
        `http://127.0.0.1:${privateServer.address().port}/private.svg`,
        (source) => {
          res.writeHead(source.statusCode, source.headers);
          source.pipe(res);
        },
      );
      upstream.end();
    });
  proxy.on("connect", (req, socket) => {
    targets.push(req.url);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const resolver = createIconResolver({
    proxyURL: `http://localhost:${proxy.address().port}`,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    allowFakeIP: false,
  });
  const result = await resolver({ url: "http://panel.example" });
  assert.equal(privateRequests, 0);
  assert.equal(result.selected, "");
  assert.ok(targets.length > 0);
  assert.ok(targets.every((target) => target === "8.8.8.8:80"));
});

test("configured icon egress resolves the proxy hostname separately and keeps private origins blocked", async (t) => {
  const paths = [],
    tunnels = [],
    hosts = [],
    origin = createServer((req, res) => {
      paths.push(req.url);
      hosts.push(req.headers.host);
      const icon = req.url.endsWith("brand.svg");
      res.writeHead(200, {
        "Content-Type": icon ? "image/svg+xml" : "text/html",
      });
      res.end(icon ? svg : '<link rel="icon" href="/brand.svg">');
    });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  t.after(() => new Promise((resolve) => origin.close(resolve)));
  const proxy = createServer();
  proxy.on("connect", (req, socket, head) => {
    tunnels.push(req.url);
    const upstream = netConnect(origin.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const resolver = createIconResolver({
    proxyURL: `http://localhost:${proxy.address().port}`,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    allowFakeIP: false,
  });
  assert.equal(
    (await resolver({ url: "http://relay.example" })).selected,
    "http://relay.example/brand.svg",
  );
  assert.deepEqual(paths, ["/", "/brand.svg"]);
  assert.deepEqual(tunnels, ["8.8.8.8:80", "8.8.8.8:80"]);
  assert.deepEqual(hosts, ["relay.example", "relay.example"]);
  assert.equal(
    (await resolver({ url: "http://169.254.169.254" })).selected,
    "",
  );
  assert.equal(paths.length, 2);
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

test("requires complete image structures instead of recognizable signatures", () => {
  const gif = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  );
  assert.equal(iconType(png, "application/octet-stream"), "image/png");
  assert.equal(iconType(gif, "image/gif"), "image/gif");
  assert.equal(iconType(Buffer.from(svg), "image/svg+xml"), "image/svg+xml");
  const ico = Buffer.alloc(22 + png.length);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = ico[7] = 1;
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(22, 18);
  png.copy(ico, 22);
  assert.equal(iconType(ico, "image/x-icon"), "image/x-icon");
  for (const [body, type] of [
    [png.subarray(0, 8), "image/png"],
    [png.subarray(0, png.length - 1), "image/png"],
    [gif.subarray(0, 6), "image/gif"],
    [gif.subarray(0, gif.length - 1), "image/gif"],
    [ico.subarray(0, ico.length - 1), "image/x-icon"],
    [Buffer.from("<svg><path>", "utf8"), "image/svg+xml"],
    [Buffer.from("<svg><path></svg>", "utf8"), "image/svg+xml"],
    [Buffer.from("<html><svg/></html>", "utf8"), "image/svg+xml"],
    [Buffer.from("ffd8ff", "hex"), "image/jpeg"],
    [Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBP", "binary"), "image/webp"],
    [Buffer.from("00000018667479706176696600000000", "hex"), "image/avif"],
    [Buffer.from("BM"), "image/bmp"],
  ])
    assert.equal(iconType(body, type), "", `${type} ${body.length} bytes`);
  const badChecksum = Buffer.from(png);
  badChecksum[20] ^= 1;
  assert.equal(iconType(badChecksum, "image/png"), "");
  ico.writeUInt32LE(ico.length, 18);
  assert.equal(iconType(ico, "image/x-icon"), "");
});

test("skips truncated advertised icons and discovers a complete fallback", async () => {
  const network = transport({
    "/": {
      status: 200,
      body: '<link rel="icon" href="/truncated.png"><link rel="icon" href="/complete.png">',
    },
    "/truncated.png": {
      status: 200,
      type: "image/png",
      body: png.subarray(0, 8),
    },
    "/complete.png": { status: 200, type: "image/png", body: png },
  });
  const result = await createIconResolver(network)({
    url: "https://relay.example",
  });
  assert.equal(result.selected, "https://relay.example/complete.png");
  assert.deepEqual(result.image.body, png);
});
