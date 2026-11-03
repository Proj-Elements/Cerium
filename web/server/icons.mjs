import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { favicon, HttpError } from "./validation.mjs";

const requestURL = (url, options, callback) =>
  (url.protocol === "https:" ? httpsRequest : httpRequest)(
    url,
    options,
    callback,
  );

const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
const reservedIPv6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 32], // Teredo, including expanded spellings.
  ["2001:2::", 48], // Benchmarking.
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32], // Documentation.
  ["2002::", 16], // 6to4 can embed private IPv4 addresses.
  ["3fff::", 20], // Documentation.
])
  reservedIPv6.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6)
    return (
      globalIPv6.check(address, "ipv6") && !reservedIPv6.check(address, "ipv6")
    );
  return false;
}

async function publicTarget(value, deadline, lookupAddress) {
  deadline.throwIfAborted();
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error("Unsafe icon origin");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let abort;
  const expired = new Promise((_, reject) => {
    abort = () => reject(deadline.reason);
    deadline.addEventListener("abort", abort, { once: true });
  });
  let addresses;
  try {
    addresses = await Promise.race([
      lookupAddress(hostname, { all: true }),
      expired,
    ]);
  } finally {
    deadline.removeEventListener("abort", abort);
  }
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new Error("Icon discovery only supports public addresses");
  return { url, address: addresses[0] };
}

async function readResource(
  target,
  deadline,
  transport,
  icon = false,
  redirects = 0,
) {
  const { url, address } = target;
  // Pin the validated address so DNS rebinding cannot turn discovery into SSRF.
  return new Promise((resolve, reject) => {
    let discarding = false;
    const onError = (error) => {
      if (!discarding) reject(error);
    };
    const request = transport.request(
      url,
      {
        signal: deadline,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        headers: {
          Accept: icon ? "image/*,application/octet-stream;q=0.8" : "text/html",
          "User-Agent": "Cerium-Icon/1.0",
        },
      },
      (response) => {
        response.on("error", onError);
        response.on("aborted", () =>
          onError(new Error("Response interrupted")),
        );
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          // Cancelling a redirect body must not reject the followed request.
          discarding = true;
          response.destroy();
          if (redirects >= 2 || !response.headers.location)
            return reject(new Error("Too many redirects"));
          let next;
          try {
            next = new URL(response.headers.location, url);
            if (icon && next.origin !== url.origin)
              throw new Error("Icon redirects must remain same-origin");
          } catch (error) {
            return reject(error);
          }
          publicTarget(next, deadline, transport.lookup).then(
            (next) =>
              readResource(next, deadline, transport, icon, redirects + 1).then(
                resolve,
                reject,
              ),
            reject,
          );
          return;
        }
        const type = (response.headers["content-type"] ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (
          response.statusCode !== 200 ||
          (icon
            ? !/^image\//.test(type) && type !== "application/octet-stream"
            : type !== "text/html")
        ) {
          discarding = true;
          response.destroy();
          return resolve({ body: Buffer.alloc(0), url, type });
        }
        const chunks = [];
        let length = 0;
        const limit = icon ? 1 << 20 : 256 << 10;
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length > limit)
            response.destroy(new Error("Icon discovery response too large"));
          else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ body: Buffer.concat(chunks), url, type }),
        );
      },
    );
    request.on("error", onError);
    request.end();
  });
}

export function findIcons(html, base) {
  const icons = [];
  for (const link of html.match(/<link\b[^>]{0,4096}>/gi) ?? []) {
    const attrs = Object.fromEntries(
      [
        ...link.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g),
      ].map((match) => [
        match[1].toLowerCase(),
        match[2] ?? match[3] ?? match[4],
      ]),
    );
    if (
      !/(^|\s)(icon|apple-touch-icon)(\s|$)/i.test(attrs.rel ?? "") ||
      !attrs.href
    )
      continue;
    try {
      const url = new URL(attrs.href.replace(/&amp;/g, "&"), base);
      // Keep discovery same-origin; never hand visitors arbitrary tracking URLs.
      url.hash = "";
      if (
        url.origin === new URL(base).origin &&
        !url.username &&
        !url.password &&
        url.href.length <= 2048
      )
        icons.push(url.href);
    } catch {
      /* Ignore malformed link elements. */
    }
  }
  return [...new Set(icons)].slice(0, 4);
}

function isIcon(body, type) {
  if (type === "image/svg+xml")
    return /<svg(?:\s|>)/i.test(body.toString("utf8", 0, 4096));
  return (
    body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    (body.length > 6 &&
      body.readUInt32LE(0) === 0x10000 &&
      body.readUInt16LE(4) > 0) ||
    /^GIF8[79]a$/.test(body.toString("ascii", 0, 6)) ||
    (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) ||
    (body.toString("ascii", 0, 4) === "RIFF" &&
      body.toString("ascii", 8, 12) === "WEBP") ||
    (body.toString("ascii", 4, 8) === "ftyp" &&
      /avif|avis/.test(body.toString("ascii", 8, 32))) ||
    body.toString("ascii", 0, 2) === "BM"
  );
}

export function createIconResolver(options = {}) {
  const transport = {
    lookup: options.lookup ?? lookup,
    request: options.request ?? requestURL,
  };
  return async (site) => {
    try {
      const pageDeadline = AbortSignal.timeout(4500),
        target = await publicTarget(site.url, pageDeadline, transport.lookup);
      let page;
      try {
        page = await readResource(target, pageDeadline, transport);
      } catch {
        page = { body: Buffer.alloc(0), url: target.url };
      }
      const base = page.url.href,
        directory = new URL(base);
      if (
        !directory.pathname.endsWith("/") &&
        !/\.[^/]+$/.test(directory.pathname)
      )
        directory.pathname += "/";
      const icons = [
        ...new Set([
          ...findIcons(page.body.toString("utf8"), base),
          ...[
            "favicon.ico",
            "favicon.svg",
            "favicon.png",
            "apple-touch-icon.png",
            "/favicon.ico",
            "/favicon.svg",
            "/favicon.png",
            "/apple-touch-icon.png",
          ].map((path) => new URL(path, directory).href),
        ]),
      ].filter((candidate) => candidate.length <= 2048);
      const probeDeadline = AbortSignal.timeout(4500);
      for (const candidate of icons) {
        if (probeDeadline.aborted) break;
        const deadline = AbortSignal.any([
          probeDeadline,
          AbortSignal.timeout(1250),
        ]);
        try {
          const target = await publicTarget(
              candidate,
              deadline,
              transport.lookup,
            ),
            image = await readResource(target, deadline, transport, true);
          if (isIcon(image.body, image.type))
            return { icons, selected: candidate };
        } catch {
          /* Try the next candidate without changing an already saved icon. */
        }
      }
      return { icons, selected: "" };
    } catch {
      return { icons: [], selected: "" };
    }
  };
}

export function createPersistentIconResolver(
  store,
  discover = createIconResolver(),
) {
  const pending = new Map();
  const result = (state) => ({ icons: state.selected ? [state.selected] : [] });
  return async (id) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = store.row(id),
        config = row && JSON.parse(row.config);
      if (!config?.enabled) throw new HttpError(404, "Site not found");
      if (row.favicon !== null) return result(JSON.parse(row.favicon));
      const key = `${id}:${row.revision}`;
      let promise = pending.get(key);
      if (!promise) {
        promise = Promise.resolve()
          .then(() =>
            config.icon
              ? { icons: [config.icon], selected: config.icon }
              : discover({ url: config.url }),
          )
          .then((value) =>
            favicon(
              {
                url: config.url,
                icons: value.icons,
                selected: value.selected ?? value.icons[0] ?? "",
              },
              config.url,
            ),
          )
          .catch(() => ({ url: config.url, icons: [], selected: "" }))
          .finally(() => pending.delete(key));
        pending.set(key, promise);
      }
      const state = await promise;
      // A delayed discovery must not overwrite edited, imported or deleted sites.
      if (store.saveFavicon(id, row.revision, state)) return result(state);
    }
    throw new HttpError(409, "Site changed during icon discovery; try again");
  };
}
