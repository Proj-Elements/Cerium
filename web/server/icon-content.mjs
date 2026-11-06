export const ICON_LIMIT = 1 << 20;

/** Return the supported MIME type for bounded image bytes, or an empty string. */
export function iconType(body, type) {
  if (!Buffer.isBuffer(body) || !body.length || body.length > ICON_LIMIT)
    return "";
  if (
    type === "image/svg+xml" &&
    /<svg(?:\s|>)/i.test(body.toString("utf8", 0, 4096))
  )
    return "image/svg+xml";
  if (body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (
    body.length > 6 &&
    body.readUInt32LE(0) === 0x10000 &&
    body.readUInt16LE(4) > 0
  )
    return "image/x-icon";
  if (/^GIF8[79]a$/.test(body.toString("ascii", 0, 6))) return "image/gif";
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)
    return "image/jpeg";
  if (
    body.toString("ascii", 0, 4) === "RIFF" &&
    body.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (
    body.toString("ascii", 4, 8) === "ftyp" &&
    /avif|avis/.test(body.toString("ascii", 8, 32))
  )
    return "image/avif";
  if (body.toString("ascii", 0, 2) === "BM") return "image/bmp";
  return "";
}
