/**
 * Minimal Blotato REST client. Read-only, on purpose.
 *
 * BASE URL, AND WHY IT IS SPELLED OUT:
 *   https://backend.blotato.com/v2
 * Blotato's own docs carry this warning, which is worth repeating because it is a
 * trap an AI coding assistant walks into constantly:
 *   "api.blotato.com is not a valid base URL. If your AI tool reports a DNS error
 *    for api.blotato.com, it guessed wrong."
 * It is in the constant below with that note attached so nobody 'fixes' it later.
 *
 * AUTH: header `blotato-api-key`, per the published OpenAPI securityScheme
 * (type apiKey, in header). `Authorization: Bearer <key>` is also accepted.
 *
 * *** THIS CLIENT ONLY EVER ISSUES GET REQUESTS. ***
 * The API can create posts and BUY CREDITS (POST /v2/credits). A preflight tool
 * has no business doing either, and a tool that holds an API key should not be one
 * keystroke away from spending money. There is no POST path in this file at all,
 * and `request()` hard-rejects any method other than GET. That is a deliberate
 * guard, not an oversight - if you need to publish, use Blotato.
 */

const BASE = 'https://backend.blotato.com/v2';
const TIMEOUT_MS = 20000;

export class BlotatoClient {
  /** @param {string} [apiKey] defaults to process.env.BLOTATO_API_KEY */
  constructor(apiKey = process.env.BLOTATO_API_KEY) {
    this.apiKey = apiKey;
  }

  get hasKey() {
    return Boolean(this.apiKey && this.apiKey.trim());
  }

  async request(path, { method = 'GET', query } = {}) {
    if (method !== 'GET') {
      throw new Error(
        `Refusing ${method}. This client is read-only by design - see the note at the top of src/blotato.js.`,
      );
    }
    if (!this.hasKey) {
      throw new Error(
        'No API key. Set BLOTATO_API_KEY in your environment (see .env.example). The key is never written to disk by this tool.',
      );
    }

    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, String(v));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'blotato-api-key': this.apiKey, Accept: 'application/json' },
        signal: controller.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        // Surface the API's own message. Guessing at causes is how you end up
        // debugging the wrong thing for an hour.
        throw new Error(`Blotato ${res.status} on GET ${path}: ${body.slice(0, 400)}`);
      }
      try {
        return JSON.parse(body);
      } catch {
        throw new Error(`Blotato returned non-JSON on GET ${path}: ${body.slice(0, 200)}`);
      }
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Blotato request timed out after ${TIMEOUT_MS}ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /v2/users/me/accounts - also the cheapest way to prove a key works. */
  accounts(platform) {
    return this.request('/users/me/accounts', { query: { platform } });
  }

  /**
   * GET /v2/posts - list posts in a window.
   * @param {{since?:string, until?:string, limit?:number, cursor?:string,
   *          status?:string[], platform?:string[]}} opts
   */
  posts(opts = {}) {
    return this.request('/posts', {
      query: {
        since: opts.since,
        until: opts.until,
        limit: opts.limit ?? 50,
        cursor: opts.cursor,
        status: opts.status,
        platform: opts.platform,
      },
    });
  }

  /** Every failed post in a window, following cursors to the end. */
  async allFailedPosts({ since, until, platform } = {}) {
    const out = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const res = await this.posts({ since, until, platform, status: ['failed'], limit: 100, cursor });
      const items = res.items || res.data || [];
      out.push(...items);
      cursor = res.cursor || res.nextCursor;
      if (!cursor || items.length === 0) break;
    }
    return out;
  }
}
