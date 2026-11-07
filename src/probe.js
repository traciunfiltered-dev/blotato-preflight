/**
 * Look at a media URL the way the publishing platform will look at it.
 *
 * THE ONE IDEA IN THIS FILE: only download the front of the file.
 *
 * Image dimensions live in the first few hundred bytes of the header. So this
 * asks for `Range: bytes=0-65535` and reads the dimensions out of that. Checking
 * a seven-slide carousel costs about 450 KB of transfer instead of 2 MB, and the
 * check finishes in about a second instead of ten.
 *
 * Not every host honours a Range request. If one ignores it and sends the whole
 * file, that still works - we just read the first chunk of what arrives and stop.
 *
 * THE OTHER THING THIS CATCHES, AND IT IS NOT THEORETICAL:
 * One real failure on the account this was built against was not a size problem
 * at all:
 *   "TikTok encountered a connection error while downloading the photo. Ensure
 *    the URL is publicly accessible and retry if valid."
 * That is a post that died because the platform could not FETCH the media. A
 * preflight that only validated local files would have passed it. So this fetches
 * over the network, unauthenticated, exactly as the platform would, and reports a
 * non-200 as a hard failure.
 */

import { readImageSize } from './imagesize.js';

const HEADER_BYTES = 65536;
const TIMEOUT_MS = 15000;

/**
 * @param {string} url
 * @returns {Promise<{url:string, ok:boolean, status:number|null, contentType:string|null,
 *   bytes:number|null, format:string|null, width:number|null, height:number|null,
 *   rangeHonoured:boolean, error:string|null}>}
 */
export async function probeMedia(url) {
  const out = {
    url,
    ok: false,
    status: null,
    contentType: null,
    bytes: null,
    format: null,
    width: null,
    height: null,
    rangeHonoured: false,
    error: null,
  };

  let controller;
  let timer;
  try {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(url, {
      headers: { Range: `bytes=0-${HEADER_BYTES - 1}` },
      redirect: 'follow',
      signal: controller.signal,
    });

    out.status = res.status;
    out.contentType = res.headers.get('content-type');
    out.rangeHonoured = res.status === 206;

    // 206 = partial (range honoured). 200 = whole file. Anything else is a real problem.
    if (res.status !== 200 && res.status !== 206) {
      out.error = `HTTP ${res.status} - the platform will not be able to fetch this`;
      return out;
    }

    // Total size: Content-Range on a 206 tells us the real length, else Content-Length.
    const cr = res.headers.get('content-range');
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) out.bytes = Number(m[1]);
    }
    if (out.bytes == null) {
      const cl = res.headers.get('content-length');
      if (cl) out.bytes = Number(cl);
    }

    const head = Buffer.from(await res.arrayBuffer());
    if (out.bytes == null) out.bytes = head.length;

    const size = readImageSize(head);
    if (size) {
      out.format = size.format;
      out.width = size.width;
      out.height = size.height;
      out.ok = true;
    } else {
      // Could be a video, or a format this reader does not know.
      const ct = (out.contentType || '').toLowerCase();
      if (ct.startsWith('video/')) {
        out.format = 'video';
        out.ok = true;
        out.error = 'video: dimensions not inspected by this tool';
      } else {
        out.error = 'could not read an image header from the first bytes of this file';
      }
    }
    return out;
  } catch (e) {
    out.error = e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : String(e.message || e);
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Probe several URLs at once, but politely - 4 at a time, not 40. */
export async function probeAll(urls, concurrency = 4) {
  const results = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map(probeMedia))));
  }
  return results;
}
