import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);

export function acceptsGzip(value = "") {
  const codings = value.split(",").map((entry) => {
    const [name, ...parameters] = entry.trim().split(";");
    const quality = parameters.find((parameter) =>
      parameter.trim().startsWith("q="),
    );
    return {
      name: name.toLowerCase(),
      quality: quality === undefined ? 1 : Number(quality.trim().slice(2)),
    };
  });
  const selected =
    codings.find((entry) => entry.name === "gzip") ??
    codings.find((entry) => entry.name === "*");
  return Boolean(selected && selected.quality > 0 && selected.quality <= 1);
}

export async function sendDirectory(req, res, data, scope = "public") {
  const raw = Buffer.from(JSON.stringify(data));
  const tag = `W/"${createHash("sha256").update(raw).digest("base64url")}"`;
  res.setHeader("ETag", tag);
  res.setHeader("Cache-Control", `${scope}, no-cache`);
  res.setHeader("Vary", "Accept-Encoding");
  const matches = (req.headers["if-none-match"] ?? "")
    .split(",")
    .map((value) => value.trim());
  if (
    matches.includes("*") ||
    matches.some(
      (value) => value.replace(/^W\//, "") === tag.replace(/^W\//, ""),
    )
  ) {
    res.writeHead(304);
    res.end();
    return;
  }
  const encoded =
    raw.length >= 1024 && acceptsGzip(req.headers["accept-encoding"]);
  const body = encoded ? await compress(raw) : raw;
  if (encoded) res.setHeader("Content-Encoding", "gzip");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}
