import { test } from "node:test";
import assert from "node:assert/strict";
import { api, APIError, assertDirectory, clearAPICache } from "../src/api.ts";
import { createLatestRequest } from "../src/latest-request.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function mockFetch(t, value) {
  const previous = globalThis.fetch;
  clearAPICache();
  globalThis.fetch = value;
  t.after(() => {
    globalThis.fetch = previous;
    clearAPICache();
  });
}

test("conditional directory requests reuse the verified body after a 304", async (t) => {
  let requests = 0;
  mockFetch(t, async (path, options) => {
    assert.equal(path, "/api/sites");
    requests++;
    if (requests === 1) {
      assert.equal(options.headers["If-None-Match"], undefined);
      return Response.json(
        { sites: [{ id: "one" }], changes: [], interval: 900 },
        { headers: { ETag: '"r1"' } },
      );
    }
    assert.equal(options.headers["If-None-Match"], '"r1"');
    return new Response(null, { status: 304 });
  });
  const options = { conditional: true, validate: assertDirectory };
  const first = await api("/api/sites", "GET", undefined, 15000, options);
  const unchanged = await api("/api/sites", "GET", undefined, 15000, options);
  assert.equal(first, unchanged);
  assert.equal(requests, 2);
});

test("overlapping identical GETs share one fetch, and errors release the request", async (t) => {
  let requests = 0;
  const pending = deferred();
  mockFetch(t, async () => {
    requests++;
    return pending.promise;
  });
  const first = api("/api/shared");
  const second = api("/api/shared");
  assert.equal(first, second);
  pending.resolve(Response.json({ error: "Offline" }, { status: 503 }));
  await assert.rejects(first, { status: 503 });
  await assert.rejects(second, { status: 503 });
  assert.equal(requests, 1);
  await assert.rejects(api("/api/shared"), APIError);
  assert.equal(requests, 2);
});

test("mutations invalidate cached credentials and old requests cannot repopulate it", async (t) => {
  const late = deferred();
  let requests = 0;
  mockFetch(t, async (path, options) => {
    requests++;
    if (requests === 1) return late.promise;
    assert.equal(options.headers["If-None-Match"], undefined);
    return Response.json({ ok: true });
  });
  const first = api("/admin/sites", "GET", undefined, 15000, {
    conditional: true,
  });
  await api("/admin/logout", "POST");
  late.resolve(
    Response.json({ private: true }, { headers: { ETag: '"old"' } }),
  );
  await first;
  await api("/admin/sites", "GET", undefined, 15000, { conditional: true });
  assert.equal(requests, 3);
});

test("external cancellation is combined with request timeout and bypasses dedupe", async (t) => {
  const first = new AbortController();
  const second = new AbortController();
  const signals = [];
  mockFetch(t, async (path, options) => {
    signals.push(options.signal);
    return Response.json({ ok: true });
  });
  await Promise.all([
    api("/api/sites", "GET", undefined, 15000, { signal: first.signal }),
    api("/api/sites", "GET", undefined, 15000, { signal: second.signal }),
  ]);
  assert.equal(signals.length, 2);
  first.abort();
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
});

test("a successful non-JSON response is surfaced as an upstream error", async (t) => {
  mockFetch(
    t,
    async () =>
      new Response("<html>proxy error</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  );
  await assert.rejects(api("/api/sites"), (error) => {
    assert(error instanceof APIError);
    assert.equal(error.status, 502);
    assert.equal(error.context?.category, "invalid_response");
    assert.equal(error.context?.stage, "response_body");
    return true;
  });
});

test("directory consumers reject a JSON object with no directory contract", async (t) => {
  mockFetch(t, async () => Response.json({}));
  const result = await api("/api/sites");
  assert.throws(
    () => assertDirectory(result),
    (error) => {
      assert(error instanceof APIError);
      assert.equal(error.status, 502);
      assert.equal(error.context?.stage, "response_shape");
      return true;
    },
  );
});

test("invalid directory responses never replace the conditional cache", async (t) => {
  const directory = { sites: [], changes: [], interval: 900 };
  let request = 0;
  mockFetch(t, async (_path, options) => {
    request++;
    if (request === 1) {
      assert.equal(options.headers["If-None-Match"], undefined);
      return Response.json({}, { headers: { ETag: '"invalid"' } });
    }
    if (request === 2) {
      assert.equal(options.headers["If-None-Match"], undefined);
      return Response.json(directory, { headers: { ETag: '"valid"' } });
    }
    assert.equal(options.headers["If-None-Match"], '"valid"');
    if (request === 3)
      return Response.json({ sites: null }, { headers: { ETag: '"broken"' } });
    return new Response(null, { status: 304 });
  });
  const options = { conditional: true, validate: assertDirectory };
  await assert.rejects(api("/api/sites", "GET", undefined, 15000, options), {
    status: 502,
  });
  const good = await api("/api/sites", "GET", undefined, 15000, options);
  await assert.rejects(api("/api/sites", "GET", undefined, 15000, options), {
    status: 502,
  });
  assert.equal(await api("/api/sites", "GET", undefined, 15000, options), good);
});

test("JSON scalars cannot become successful objects and non-JSON HTTP errors retain their status", async (t) => {
  let value;
  mockFetch(t, async () => value);
  for (const body of [null, [], "ok", 42, false]) {
    value = Response.json(body);
    await assert.rejects(api("/api/value"), { status: 502 });
  }
  value = new Response("<html>Login required</html>", { status: 401 });
  await assert.rejects(api("/api/value"), { status: 401 });
});

test("structured conflict codes survive the API error boundary", async (t) => {
  mockFetch(t, async () =>
    Response.json(
      { error: "Duplicate identity", code: "duplicate_identity" },
      { status: 409 },
    ),
  );
  await assert.rejects(api("/admin/sites", "POST", {}), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.context.code, "duplicate_identity");
    return true;
  });
});

test("response body cancellation remains an abort rather than a malformed response", async (t) => {
  const controller = new AbortController();
  mockFetch(t, async () => ({
    status: 200,
    ok: true,
    json: async () => {
      controller.abort();
      throw controller.signal.reason;
    },
  }));
  await assert.rejects(
    api("/api/sites", "GET", undefined, 15000, { signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("a superseded response cannot replace the newer value even if fetch ignores abort", async () => {
  const requests = createLatestRequest();
  const stale = deferred();
  let oldSignal;
  const first = requests.run((signal) => {
    oldSignal = signal;
    return stale.promise;
  });
  const second = await requests.run(async () => "new");
  stale.resolve("old");
  assert.deepEqual(second, { current: true, value: "new" });
  assert.deepEqual(await first, { current: false });
  assert.equal(oldSignal.aborted, true);
});

test("unmount cancellation suppresses late success and late errors", async () => {
  for (const fails of [false, true]) {
    const requests = createLatestRequest();
    const pending = deferred();
    const result = requests.run(() => pending.promise);
    requests.cancel();
    if (fails) pending.reject(new Error("Late failure"));
    else pending.resolve("Late success");
    assert.deepEqual(await result, { current: false });
  }
});
