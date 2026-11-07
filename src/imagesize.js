/**
 * Read image dimensions and real format straight out of the file header.
 *
 * WHY THIS EXISTS INSTEAD OF AN npm PACKAGE:
 * This whole project has zero dependencies. Not for purity - for three practical
 * reasons. It clones and runs with no install step, there is no supply chain to
 * trust for a tool that will hold an API key, and `image-size` would be ~40 lines
 * of actual work hidden behind a package you then have to keep updated.
 *
 * WHY IT READS THE HEADER AND NOT THE FILENAME:
 * Blotato's own documentation says it plainly:
 *   "An .mp4 filename does not prove the container, codecs, or aspect ratio.
 *    Upload success does not establish platform compatibility."
 * The same is true of .jpeg. A PNG renamed to .jpeg is still a PNG, and TikTok
 * will reject it while your file listing looks fine. So the format reported here
 * is always the format the BYTES say, never the one the URL says.
 */

/** @returns {{format:string,width:number,height:number}|null} */
export function readImageSize(buf) {
  if (!buf || buf.length < 16) return null;
  return png(buf) || gif(buf) || webp(buf) || jpeg(buf) || bmp(buf) || null;
}

function png(b) {
  // 89 50 4E 47 0D 0A 1A 0A, then IHDR at byte 16
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  if (b.length < 24) return null;
  return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b) {
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
  if (b.length < 10) return null;
  return { format: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function bmp(b) {
  if (b[0] !== 0x42 || b[1] !== 0x4d) return null;
  if (b.length < 26) return null;
  return { format: 'bmp', width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
}

function webp(b) {
  // RIFF....WEBP then one of three chunk types, each with its own size encoding.
  if (b.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);

  if (chunk === 'VP8 ') {
    // lossy: 16-bit dims at offset 26, masked to 14 bits
    if (b.length < 30) return null;
    return {
      format: 'webp',
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    // lossless: 14-bit dims packed across 4 bytes at offset 21, minus one
    if (b.length < 25) return null;
    const bits = b.readUInt32LE(21);
    return {
      format: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8X') {
    // extended: 24-bit canvas dims at offset 24, minus one
    if (b.length < 30) return null;
    const w = b[24] | (b[25] << 8) | (b[26] << 16);
    const h = b[27] | (b[28] << 8) | (b[29] << 16);
    return { format: 'webp', width: w + 1, height: h + 1 };
  }
  return null;
}

/**
 * JPEG: walk the marker segments until a Start Of Frame.
 *
 * This is the fiddly one. A JPEG is a chain of segments, each 0xFF then a marker
 * byte then a 2-byte length. Dimensions live in an SOF segment, and there are
 * several SOF flavours (baseline, progressive, and friends) - SOF0 through SOF15,
 * skipping 0xC4 (define huffman table), 0xC8 and 0xCC, which are not frame starts.
 * You cannot just look at a fixed offset, because EXIF thumbnails and colour
 * profiles sit in front of the real frame and will happily give you the wrong
 * numbers if you guess.
 */
function jpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) {
      i++; // resync: padding between segments is legal
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      // SOF payload: [len:2][precision:1][height:2][width:2]
      return {
        format: 'jpeg',
        height: b.readUInt16BE(i + 5),
        width: b.readUInt16BE(i + 7),
      };
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null; // malformed, bail rather than loop forever
    i += 2 + len;
  }
  return null;
}
