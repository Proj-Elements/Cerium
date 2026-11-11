import { inflateSync } from "node:zlib";

export const ICON_LIMIT = 1 << 20;

const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const dimensions = (width, height) =>
  width > 0 && height > 0 && width * height <= 16777216;
const checksumTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = (value >>> 8) ^ checksumTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
function png(body) {
  if (body.length < 57 || !body.subarray(0, 8).equals(pngSignature))
    return false;
  let offset = 8,
    header = false,
    palette = false,
    color,
    depth,
    width,
    height,
    interlace,
    finishedData = false;
  const data = [];
  while (offset + 12 <= body.length) {
    const length = body.readUInt32BE(offset),
      end = offset + 12 + length,
      kind = body.toString("ascii", offset + 4, offset + 8);
    if (
      end > body.length ||
      !/^[A-Za-z]{4}$/.test(kind) ||
      crc(body.subarray(offset + 4, end - 4)) !== body.readUInt32BE(end - 4)
    )
      return false;
    if (!header) {
      if (kind !== "IHDR" || length !== 13) return false;
      depth = body[offset + 16];
      color = body[offset + 17];
      width = body.readUInt32BE(offset + 8);
      height = body.readUInt32BE(offset + 12);
      interlace = body[offset + 20];
      if (
        !dimensions(width, height) ||
        !{
          0: [1, 2, 4, 8, 16],
          2: [8, 16],
          3: [1, 2, 4, 8],
          4: [8, 16],
          6: [8, 16],
        }[color]?.includes(depth) ||
        body[offset + 18] !== 0 ||
        body[offset + 19] !== 0 ||
        body[offset + 20] > 1
      )
        return false;
      header = true;
    } else if (kind === "IHDR") return false;
    else if (kind === "PLTE") {
      if (data.length || !length || length % 3 || length > 768) return false;
      palette = true;
    } else if (kind === "IDAT") {
      if (finishedData || (color === 3 && !palette)) return false;
      data.push(body.subarray(offset + 8, end - 4));
    } else if (kind === "IEND") {
      if (length || end !== body.length || !data.length) return false;
      const decoded = inflateSync(Buffer.concat(data), {
          maxOutputLength: 64 << 20,
        }),
        channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color],
        passes = interlace
          ? [
              [0, 0, 8, 8],
              [4, 0, 8, 8],
              [0, 4, 4, 8],
              [2, 0, 4, 4],
              [0, 2, 2, 4],
              [1, 0, 2, 2],
              [0, 1, 1, 2],
            ]
          : [[0, 0, 1, 1]];
      let cursor = 0;
      for (const [startX, startY, stepX, stepY] of passes) {
        const passWidth = Math.max(0, Math.ceil((width - startX) / stepX)),
          rows = passWidth
            ? Math.max(0, Math.ceil((height - startY) / stepY))
            : 0,
          stride = Math.ceil((passWidth * channels * depth) / 8) + 1;
        for (let row = 0; row < rows; row++) {
          if (cursor + stride > decoded.length || decoded[cursor] > 4)
            return false;
          cursor += stride;
        }
      }
      return cursor === decoded.length;
    } else {
      if (data.length) finishedData = true;
      if (kind[0] === kind[0].toUpperCase()) return false;
    }
    offset = end;
  }
  return false;
}
function svg(body) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(body),
    tags = [];
  let offset = 0,
    root = false;
  while (offset < source.length) {
    const start = source.indexOf("<", offset),
      text = source.slice(offset, start < 0 ? source.length : start);
    if (!tags.length && text.trim()) return false;
    if (start < 0) break;
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      if (end < 0) return false;
      offset = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", start)) {
      const end = source.indexOf("]]>", start + 9);
      if (end < 0 || !tags.length) return false;
      offset = end + 3;
      continue;
    }
    if (source.startsWith("<?xml", start) && !root) {
      const end = source.indexOf("?>", start + 5);
      if (end < 0) return false;
      offset = end + 2;
      continue;
    }
    const token = source
      .slice(start)
      .match(
        /^<(\/?)([A-Za-z_][\w:.-]*)(\s+(?:[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*')\s*)*)?\s*(\/?)>/,
      );
    if (!token) return false;
    const [, closing, name, attributes, selfClosing] = token;
    if (closing) {
      if (attributes?.trim() || selfClosing || tags.pop() !== name)
        return false;
    } else {
      if (!tags.length) {
        if (root || name !== "svg") return false;
        root = true;
      }
      if (!selfClosing) tags.push(name);
    }
    offset = start + token[0].length;
  }
  return root && !tags.length;
}
function gif(body) {
  if (
    body.length < 14 ||
    !dimensions(body.readUInt16LE(6), body.readUInt16LE(8))
  )
    return false;
  let offset = 13 + (body[10] & 128 ? 3 * 2 ** ((body[10] & 7) + 1) : 0),
    image = false;
  const blocks = () => {
    while (offset < body.length) {
      const length = body[offset++];
      if (!length) return true;
      offset += length;
      if (offset > body.length) return false;
    }
    return false;
  };
  while (offset < body.length) {
    const kind = body[offset++];
    if (kind === 0x3b) return image && offset === body.length;
    if (kind === 0x21) {
      if (offset >= body.length) return false;
      offset++;
    } else if (kind === 0x2c) {
      if (
        offset + 9 > body.length ||
        !dimensions(
          body.readUInt16LE(offset + 4),
          body.readUInt16LE(offset + 6),
        )
      )
        return false;
      const packed = body[offset + 8];
      offset += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      if (offset >= body.length || body[offset] < 2 || body[offset] > 8)
        return false;
      offset++;
      image = true;
    } else return false;
    if (!blocks()) return false;
  }
  return false;
}
function jpeg(body) {
  let offset = 2,
    frame = false,
    scan = false;
  while (offset < body.length) {
    if (body[offset++] !== 0xff) return false;
    while (body[offset] === 0xff) offset++;
    const kind = body[offset++];
    if (kind === 0xd9) return frame && scan && offset === body.length;
    if (kind === 0 || kind === 0xd8 || kind === undefined) return false;
    if (kind === 1 || (kind >= 0xd0 && kind <= 0xd7)) continue;
    if (offset + 2 > body.length) return false;
    const length = body.readUInt16BE(offset),
      end = offset + length;
    if (length < 2 || end > body.length) return false;
    if (kind >= 0xc0 && kind <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(kind)) {
      if (
        length < 8 ||
        !dimensions(
          body.readUInt16BE(offset + 5),
          body.readUInt16BE(offset + 3),
        )
      )
        return false;
      frame = true;
    }
    offset = end;
    if (kind === 0xda) {
      if (!frame || length < 6) return false;
      scan = true;
      while (offset < body.length) {
        if (body[offset] !== 0xff) {
          offset++;
          continue;
        }
        if (
          body[offset + 1] === 0 ||
          (body[offset + 1] >= 0xd0 && body[offset + 1] <= 0xd7)
        ) {
          offset += 2;
          continue;
        }
        break;
      }
    }
  }
  return false;
}
function bitmap(body, icon = false) {
  const offset = icon ? 0 : 14;
  if (body.length < offset + 40) return false;
  const headerSize = body.readUInt32LE(offset),
    width = body.readInt32LE(offset + 4),
    height = body.readInt32LE(offset + 8),
    depth = body.readUInt16LE(offset + 14),
    pixels = icon
      ? headerSize +
        (depth <= 8 ? 4 * (body.readUInt32LE(offset + 32) || 2 ** depth) : 0)
      : body.readUInt32LE(10);
  if (
    headerSize < 40 ||
    headerSize > body.length - offset ||
    !dimensions(width, Math.abs(height)) ||
    body.readUInt16LE(offset + 12) !== 1 ||
    ![1, 4, 8, 16, 24, 32].includes(depth) ||
    pixels < offset + headerSize ||
    pixels >= body.length
  )
    return false;
  if (!icon && body.readUInt32LE(2) !== body.length) return false;
  if (body.readUInt32LE(offset + 16) === 0) {
    const rows = Math.abs(height) / (icon ? 2 : 1),
      stride = Math.ceil((width * depth) / 32) * 4;
    if (!Number.isInteger(rows) || pixels + rows * stride > body.length)
      return false;
  }
  return true;
}
function ico(body) {
  if (body.length < 22 || body.readUInt32LE(0) !== 0x10000) return false;
  const count = body.readUInt16LE(4),
    directory = 6 + 16 * count;
  if (!count || directory > body.length) return false;
  for (let index = 0; index < count; index++) {
    const entry = 6 + 16 * index,
      length = body.readUInt32LE(entry + 8),
      offset = body.readUInt32LE(entry + 12);
    if (!length || offset < directory || offset + length > body.length)
      return false;
    const image = body.subarray(offset, offset + length);
    if (!png(image) && !bitmap(image, true)) return false;
  }
  return true;
}
function webp(body) {
  if (body.length < 30 || body.readUInt32LE(4) + 8 !== body.length)
    return false;
  let image = false,
    offset = 12;
  while (offset + 8 <= body.length) {
    const kind = body.toString("ascii", offset, offset + 4),
      length = body.readUInt32LE(offset + 4),
      end = offset + 8 + length;
    if (!length || end > body.length) return false;
    if (kind === "VP8 ") {
      if (
        length < 10 ||
        !body
          .subarray(offset + 11, offset + 14)
          .equals(Buffer.from("9d012a", "hex")) ||
        !dimensions(
          body.readUInt16LE(offset + 14) & 0x3fff,
          body.readUInt16LE(offset + 16) & 0x3fff,
        )
      )
        return false;
      image = true;
    } else if (kind === "VP8L") {
      if (length < 5 || body[offset + 8] !== 0x2f) return false;
      image = true;
    } else if (kind === "ANMF") {
      if (length < 24) return false;
      image = true;
    }
    offset = end + (length & 1);
  }
  return image && offset === body.length;
}
function avif(body) {
  let offset = 0,
    brand = false,
    metadata = false,
    data = false;
  while (offset + 8 <= body.length) {
    const length = body.readUInt32BE(offset),
      kind = body.toString("ascii", offset + 4, offset + 8),
      end = length === 0 ? body.length : offset + length;
    if ((length !== 0 && length < 8) || end > body.length) return false;
    if (kind === "ftyp")
      brand =
        length >= 16 &&
        /^(?:avif|avis)$/.test(body.toString("ascii", offset + 8, offset + 12));
    if (kind === "meta") metadata = length >= 16;
    if (kind === "mdat") data = end > offset + 8;
    offset = end;
  }
  return offset === body.length && brand && metadata && data;
}

/** Return the MIME type only for a bounded, structurally complete image. */
export function iconType(body, type) {
  if (!Buffer.isBuffer(body) || !body.length || body.length > ICON_LIMIT)
    return "";
  try {
    if (type === "image/svg+xml") return svg(body) ? type : "";
    if (body.subarray(0, 8).equals(pngSignature))
      return png(body) ? "image/png" : "";
    if (body.length >= 4 && body.readUInt32LE(0) === 0x10000)
      return ico(body) ? "image/x-icon" : "";
    if (/^GIF8[79]a$/.test(body.toString("ascii", 0, 6)))
      return gif(body) ? "image/gif" : "";
    if (body[0] === 0xff && body[1] === 0xd8)
      return jpeg(body) ? "image/jpeg" : "";
    if (
      body.toString("ascii", 0, 4) === "RIFF" &&
      body.toString("ascii", 8, 12) === "WEBP"
    )
      return webp(body) ? "image/webp" : "";
    if (body.toString("ascii", 4, 8) === "ftyp")
      return avif(body) ? "image/avif" : "";
    if (body.toString("ascii", 0, 2) === "BM")
      return bitmap(body) ? "image/bmp" : "";
  } catch {
    return "";
  }
  return "";
}
