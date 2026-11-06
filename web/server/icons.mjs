import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { favicon, HttpError } from "./validation.mjs";
import { createIconRequest } from "./icon-transport.mjs";
import { ICON_LIMIT, iconType } from "./icon-content.mjs";

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

function isFakeIP(address) {
  const [a, b] = address.split(".").map(Number);
  return isIP(address) === 4 && a === 198 && (b === 18 || b === 19);
}

async function publicTarget(value, deadline, transport) {
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
  if (isIP(hostname) && !isPublicAddress(hostname))
    throw new Error("Icon discovery only supports public addresses");
  let abort;
  const expired = new Promise((_, reject) => {
    abort = () => reject(deadline.reason);
    deadline.addEventListener("abort", abort, { once: true });
  });
  let addresses;
  try {
    addresses = await Promise.race([
      transport.lookup(hostname, { all: true }),
      expired,
    ]);
  } finally {
    deadline.removeEventListener("abort", abort);
  }
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) =>
        !isPublicAddress(address) &&
        !(transport.allowFakeIP && !isIP(hostname) && isFakeIP(address)),
    )
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
        targetAddress: address.address,
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
          publicTarget(next, deadline, transport).then(
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
        const limit = icon ? ICON_LIMIT : 256 << 10;
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

/** Discover bounded image bytes, trying an existing or explicit address first. */
export function createIconResolver(options = {}) {
  const transport = {
    lookup: options.lookup ?? lookup,
    request:
      options.request ??
      createIconRequest(
        options.proxyURL ?? process.env.CERIUM_OUTBOUND_PROXY_URL,
      ),
    // Only a trusted TUN proxy can make benchmark-range DNS answers routable.
    // Literal IPs, metadata endpoints and all other private ranges stay blocked.
    allowFakeIP:
      options.allowFakeIP ?? process.env.CERIUM_ICON_ALLOW_FAKE_IP === "true",
  };
  return async (site) => {
    try {
      if (site.preferred) {
        try {
          const deadline = AbortSignal.timeout(5000),
            target = await publicTarget(site.preferred, deadline, transport),
            image = await readResource(target, deadline, transport, true),
            type = iconType(image.body, image.type);
          if (type)
            return {
              icons: [site.preferred],
              selected: site.preferred,
              image: { body: image.body, type },
            };
        } catch {
          /* Retry normal discovery if a previously selected address is stale. */
        }
        if (site.explicit) return { icons: [site.preferred], selected: "" };
      }
      const pageDeadline = AbortSignal.timeout(10000),
        target = await publicTarget(site.url, pageDeadline, transport);
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
      const probeDeadline = AbortSignal.timeout(10000);
      for (const candidate of icons) {
        if (probeDeadline.aborted) break;
        const deadline = AbortSignal.any([
          probeDeadline,
          AbortSignal.timeout(5000),
        ]);
        try {
          const target = await publicTarget(candidate, deadline, transport),
            image = await readResource(target, deadline, transport, true),
            type = iconType(image.body, image.type);
          if (type)
            return {
              icons,
              selected: candidate,
              image: { body: image.body, type },
            };
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

/** Resolve to a same-origin image path, lazily migrating older URL-only records. */
export function createPersistentIconResolver(
  store,
  discover = createIconResolver(),
) {
  const pending = new Map();
  const result = (id, row) => ({
    icons: row.favicon_blob ? [`/api/sites/${id}/icon/image`] : [],
  });
  return async (id) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = store.row(id),
        config = row && JSON.parse(row.config);
      if (!config?.enabled) throw new HttpError(404, "Site not found");
      const previous = row.favicon === null ? null : JSON.parse(row.favicon);
      if (
        previous &&
        ((previous.selected && row.favicon_blob && row.favicon_type) ||
          Date.now() - Date.parse(previous.checked_at) < 15 * 60000)
      )
        return result(id, row);
      const key = `${id}:${row.revision}`;
      let promise = pending.get(key);
      if (!promise) {
        promise = Promise.resolve()
          .then(() => {
            const preferred = config.icon || previous?.selected;
            return discover({
              url: config.url,
              ...(preferred ? { preferred } : {}),
              ...(config.icon ? { explicit: true } : {}),
            });
          })
          .then((value) => {
            const type = iconType(value.image?.body, value.image?.type),
              selected = type ? (value.selected ?? value.icons[0] ?? "") : "";
            return {
              state:
                !selected && previous?.selected
                  ? {
                      ...previous,
                      checked_at: new Date().toISOString(),
                    }
                  : favicon(
                      {
                        url: config.url,
                        icons: value.icons,
                        selected,
                        ...(!selected
                          ? { checked_at: new Date().toISOString() }
                          : {}),
                      },
                      config.url,
                    ),
              image: selected ? { body: value.image.body, type } : null,
            };
          })
          .catch(() => ({
            state: previous?.selected
              ? { ...previous, checked_at: new Date().toISOString() }
              : {
                  url: config.url,
                  icons: [],
                  selected: "",
                  checked_at: new Date().toISOString(),
                },
            image: null,
          }))
          .finally(() => pending.delete(key));
        pending.set(key, promise);
      }
      const { state, image } = await promise;
      // A delayed discovery must not overwrite edited, imported or deleted sites.
      if (store.saveFavicon(id, row.revision, state, row.favicon, image))
        return result(id, store.row(id));
    }
    throw new HttpError(409, "Site changed during icon discovery; try again");
  };
}
