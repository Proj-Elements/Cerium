import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

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

async function publicTarget(value) {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error("Unsafe icon origin");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new Error("Icon discovery only supports public addresses");
  return { url, address: addresses[0] };
}

async function readPage(target, deadline, redirects = 0) {
  const { url, address } = target;
  // Pin the validated address so DNS rebinding cannot turn discovery into SSRF.
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        signal: deadline,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        headers: { Accept: "text/html", "User-Agent": "Cerium-Icon/1.0" },
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (redirects >= 2 || !response.headers.location)
            return reject(new Error("Too many redirects"));
          publicTarget(new URL(response.headers.location, url)).then(
            (next) =>
              readPage(next, deadline, redirects + 1).then(resolve, reject),
            reject,
          );
          return;
        }
        if (
          response.statusCode !== 200 ||
          !/text\/html/i.test(response.headers["content-type"] ?? "")
        ) {
          response.resume();
          return resolve({ html: "", url });
        }
        const chunks = [];
        let length = 0;
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length > 256 * 1024)
            response.destroy(new Error("Homepage too large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({ html: Buffer.concat(chunks).toString("utf8"), url }),
        );
      },
    );
    request.on("error", reject);
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
      if (url.origin === new URL(base).origin && !url.username && !url.password)
        icons.push(url.href);
    } catch {
      /* Ignore malformed link elements. */
    }
  }
  return [...new Set(icons)].slice(0, 4);
}

export function createIconResolver() {
  const cache = new Map();
  return async (site) => {
    const key = site.url;
    if (cache.get(key)?.until > Date.now()) return cache.get(key).promise;
    const promise = (async () => {
      try {
        const target = await publicTarget(site.url);
        let page;
        try {
          page = await readPage(target, AbortSignal.timeout(4500));
        } catch {
          page = { html: "", url: target.url };
        }
        const base = page.url.href;
        return {
          icons: [
            ...new Set([
              ...findIcons(page.html, base),
              new URL("favicon.ico", base).href,
              new URL("logo.svg", base).href,
              new URL("/favicon.ico", base).href,
            ]),
          ],
        };
      } catch {
        return { icons: [] };
      }
    })();
    if (cache.size >= 250) cache.delete(cache.keys().next().value);
    cache.set(key, { until: Date.now() + 3600000, promise });
    return promise;
  };
}
