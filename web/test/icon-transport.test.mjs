import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import { createIconRequest } from "../server/icon-transport.mjs";
import { key, cert } from "./fixtures/icon-tls.mjs";

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

function read(request, url, input = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(url),
      {
        targetAddress: "8.8.8.8",
        signal: AbortSignal.timeout(2000),
        ca: cert,
        ...input,
      },
      (response) => {
        const chunks = [];
        response.on("error", reject);
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString()));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function proxy(t, originPort, secure = false) {
  const targets = [],
    server = secure ? httpsServer({ key, cert }) : httpServer();
  server.on("connect", (req, socket, head) => {
    targets.push({ target: req.url, headers: req.headers });
    const upstream = connect(originPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
  });
  return {
    targets,
    url: `${secure ? "https" : "http"}://localhost:${await listen(t, server)}`,
  };
}

for (const secure of [false, true]) {
  test(`${secure ? "HTTPS" : "HTTP"} proxy pins IPv4/IPv6 CONNECT and preserves TLS SNI, certificate identity and Host`, async (t) => {
    const hosts = [],
      origin = httpsServer({ key, cert }, (req, res) => {
        hosts.push({ host: req.headers.host, sni: req.socket.servername });
        assert.equal(req.headers["proxy-authorization"], undefined);
        res.end("secure icon");
      }),
      p = await proxy(t, await listen(t, origin), secure),
      request = createIconRequest(p.url);
    for (const address of ["8.8.8.8", "2606:4700:4700::1111"]) {
      assert.equal(
        await read(request, "https://relay.example/logo.svg", {
          targetAddress: address,
        }),
        "secure icon",
      );
    }
    assert.deepEqual(
      p.targets.map(({ target }) => target),
      ["8.8.8.8:443", "[2606:4700:4700::1111]:443"],
    );
    assert.deepEqual(hosts, [
      { host: "relay.example", sni: "relay.example" },
      { host: "relay.example", sni: "relay.example" },
    ]);
    await assert.rejects(read(request, "https://wrong.example/icon.svg"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    assert.equal(hosts.length, 2);
  });
}

test("proxy credentials stay in CONNECT and never reach the tunneled origin", async (t) => {
  const origin = httpServer((req, res) => {
    assert.equal(req.headers.host, "relay.example");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["proxy-authorization"], undefined);
    res.end("icon");
  });
  const p = await proxy(t, await listen(t, origin));
  const authenticated = new URL(p.url);
  authenticated.username = "fixture-user";
  authenticated.password = "fixture-password";
  assert.equal(
    await read(createIconRequest(authenticated.href), "http://relay.example"),
    "icon",
  );
  assert.equal(p.targets[0].target, "8.8.8.8:80");
  assert.equal(p.targets[0].headers.authorization, undefined);
  assert.equal(
    p.targets[0].headers["proxy-authorization"],
    "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64"),
  );
});

test("environment proxies retain hostname and port NO_PROXY bypasses", async (t) => {
  const origin = httpServer((_req, res) => res.end("direct icon")),
    port = await listen(t, origin),
    p = await proxy(t, port),
    lookup = (_host, options, callback) => {
      const address = { address: "127.0.0.1", family: 4 };
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
  for (const NO_PROXY of [
    "*",
    ".example",
    "*.example",
    `relay.example:${port}`,
  ]) {
    const request = createIconRequest(undefined, {
      HTTP_PROXY: p.url,
      NO_PROXY,
    });
    assert.equal(
      await read(request, `http://relay.example:${port}`, { lookup }),
      "direct icon",
    );
  }
  assert.equal(p.targets.length, 0);
  assert.equal(
    await read(
      createIconRequest(undefined, { HTTP_PROXY: p.url }),
      "http://relay.example",
    ),
    "direct icon",
  );
  assert.equal(p.targets[0].target, "8.8.8.8:80");
});

test("a stalled proxy CONNECT is aborted and malformed proxy origins never expose credentials", async (t) => {
  const server = httpServer();
  server.on("connect", () => {});
  const port = await listen(t, server);
  await assert.rejects(
    read(
      createIconRequest(`http://127.0.0.1:${port}`),
      "http://relay.example",
      {
        signal: AbortSignal.timeout(30),
      },
    ),
    { code: "ABORT_ERR" },
  );
  for (const value of [
    "socks5://fixture-user:fixture-password@localhost:1080",
    "http://fixture-user:fixture-password@localhost/path",
    "http://[fixture-password",
  ]) {
    assert.throws(
      () => createIconRequest(value)(new URL("http://relay.example"), {}),
      { message: "Invalid icon egress proxy" },
    );
  }
});
