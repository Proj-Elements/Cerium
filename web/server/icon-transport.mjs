import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";

const agents = {
  "http:": new HttpAgent({ proxyEnv: {} }),
  "https:": new HttpsAgent({ proxyEnv: {} }),
};
const request = (url, input, callback) =>
  (url.protocol === "https:" ? httpsRequest : httpRequest)(
    url,
    input,
    callback,
  );

function bypassProxy(url, value = "") {
  const host = url.hostname.toLowerCase(),
    ip = host.replace(/^\[|\]$/g, ""),
    port = url.port || (url.protocol === "https:" ? "443" : "80");
  return value.split(",").some((entry) => {
    entry = entry.trim().toLowerCase();
    if (entry === "*" || entry === ip) return true;
    if (isIP(ip) === 4 && entry.includes("-")) {
      const [start, end] = entry.split("-").map((value) => value.trim()),
        range = new BlockList();
      if (isIP(start) === 4 && isIP(end) === 4) {
        try {
          range.addRange(start, end);
          if (range.check(ip)) return true;
        } catch {
          /* Ignore invalid proxy-bypass ranges. */
        }
      }
    }
    const parts = entry.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!parts || (parts[2] && parts[2] !== port)) return false;
    const name = parts[1];
    if (name.startsWith("*.")) return host.endsWith(name.slice(1));
    if (name.startsWith("."))
      return host === name.slice(1) || host.endsWith(name);
    return host === name;
  });
}

function proxyURL(url, configured, env) {
  const raw =
    configured ||
    (bypassProxy(url, env.no_proxy || env.NO_PROXY)
      ? ""
      : url.protocol === "https:"
        ? env.https_proxy || env.HTTPS_PROXY
        : env.http_proxy || env.HTTP_PROXY);
  if (!raw) return null;
  let proxy;
  try {
    proxy = new URL(raw);
  } catch {
    throw new Error("Invalid icon egress proxy");
  }
  if (
    !["http:", "https:"].includes(proxy.protocol) ||
    (proxy.pathname && proxy.pathname !== "/") ||
    proxy.search ||
    proxy.hash
  )
    throw new Error("Invalid icon egress proxy");
  return proxy;
}

// CONNECT must use the already validated IP, never a hostname resolved again by
// the proxy. The tunneled request retains the original Host and TLS identity.
function tunnelAgent(url, proxy, input) {
  const agent = new (url.protocol === "https:" ? HttpsAgent : HttpAgent)({
    proxyEnv: {},
  });
  agent.createConnection = (_options, callback) => {
    const address = input.targetAddress,
      host = url.hostname.replace(/^\[|\]$/g, ""),
      authority = `${isIP(address) === 6 ? `[${address}]` : address}:${url.port || (url.protocol === "https:" ? 443 : 80)}`,
      headers = { Host: authority };
    if (!isIP(address)) return callback(new Error("Missing validated icon IP"));
    if (proxy.username || proxy.password)
      headers["Proxy-Authorization"] =
        "Basic " +
        Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString("base64");
    let finished = false;
    const finish = (error, socket) => {
      if (finished) return socket?.destroy();
      finished = true;
      callback(error, socket);
    };
    const proxyEndpoint = new URL(proxy);
    proxyEndpoint.username = "";
    proxyEndpoint.password = "";
    const proxyHost = proxy.hostname.replace(/^\[|\]$/g, ""),
      connect = request(proxyEndpoint, {
        method: "CONNECT",
        path: authority,
        headers,
        signal: input.signal,
        agent: agents[proxy.protocol],
        servername: isIP(proxyHost) ? undefined : proxyHost,
        ca: input.ca,
      });
    connect.once("error", (error) => finish(error));
    connect.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200 || input.signal.aborted) {
        socket.destroy();
        return finish(new Error("Icon proxy tunnel rejected"));
      }
      if (head.length) socket.unshift(head);
      finish(
        null,
        url.protocol === "https:"
          ? tlsConnect({
              socket,
              host,
              servername: isIP(host) ? undefined : host,
              ca: input.ca,
            })
          : socket,
      );
    });
    connect.end();
  };
  return agent;
}

/**
 * Create icon requests; configured proxy overrides env proxy/NO_PROXY settings.
 * Callers supply a validated targetAddress and abort signal with each request.
 */
export function createIconRequest(configured, env = process.env) {
  return (url, input, callback) => {
    const proxy = proxyURL(url, configured, env);
    return request(
      url,
      {
        ...input,
        agent: proxy ? tunnelAgent(url, proxy, input) : agents[url.protocol],
      },
      callback,
    );
  };
}
