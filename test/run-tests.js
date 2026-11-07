/**
 * Tests. No framework, no network (except the one test that says it uses it).
 *
 * WHY MOST TESTS INJECT PROBES INSTEAD OF FETCHING:
 * `validatePost` takes an optional `probes` array. That is not an accident of the
 * design, it is the reason the design is that shape - it lets the rules be tested
 * against exact dimensions with no network, so the suite is fast, offline and
 * deterministic. Splitting "go look at the file" from "judge the file" is what
 * makes that possible.
 *
 * THE TESTS THAT MATTER MOST are the REGRESSION ones. They encode four real
 * failed posts with their real dimensions and their real error messages from the
 * platform, and assert the tool reaches the same verdict the platform did. If a
 * rule change ever stops catching those, the suite fails.
 */

import { readImageSize } from '../src/imagesize.js';
import { validatePost } from '../src/validate.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('use ta() for async tests');
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}
async function ta(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function truthy(v, msg) {
  if (!v) throw new Error(msg || 'expected truthy');
}

const probe = (w, h, over = {}) => ({
  url: `mem://${w}x${h}`,
  ok: true,
  status: 206,
  contentType: 'image/jpeg',
  bytes: 200 * 1024,
  format: 'jpeg',
  width: w,
  height: h,
  rangeHonoured: true,
  error: null,
  ...over,
});
const blocking = (res) => res.findings.filter((f) => f.severity === 'fail');

// ---------------------------------------------------------------- imagesize
console.log('\nimagesize - headers are parsed, not filenames trusted');

t('PNG IHDR', () => {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(1080, 16);
  b.writeUInt32BE(1350, 20);
  const r = readImageSize(b);
  eq(r.format, 'png');
  eq(r.width, 1080);
  eq(r.height, 1350);
});

t('GIF little-endian dims', () => {
  const b = Buffer.alloc(16);
  Buffer.from('GIF89a').copy(b, 0);
  b.writeUInt16LE(640, 6);
  b.writeUInt16LE(480, 8);
  const r = readImageSize(b);
  eq(r.format, 'gif');
  eq(r.width, 640);
  eq(r.height, 480);
});

t('WebP VP8L packs 14-bit dims minus one', () => {
  const b = Buffer.alloc(32);
  Buffer.from('RIFF').copy(b, 0);
  Buffer.from('WEBP').copy(b, 8);
  Buffer.from('VP8L').copy(b, 12);
  const w = 1080,
    h = 1350;
  b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
  const r = readImageSize(b);
  eq(r.format, 'webp');
  eq(r.width, 1080);
  eq(r.height, 1350);
});

t('JPEG walks segments past a decoy APP1 to the real SOF0', () => {
  // SOI, then an APP1 block holding plausible-but-wrong numbers, then SOF0.
  // This is the EXIF-thumbnail trap: reading a fixed offset returns the decoy.
  const parts = [
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1, 0x00, 0x0c]),
    Buffer.from([0x00, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
    (() => {
      const d = Buffer.alloc(4);
      d.writeUInt16BE(1402, 0); // height
      d.writeUInt16BE(1122, 2); // width
      return d;
    })(),
    Buffer.alloc(8),
  ];
  const r = readImageSize(Buffer.concat(parts));
  eq(r.format, 'jpeg');
  eq(r.width, 1122, 'width must come from SOF0, not the APP1 decoy');
  eq(r.height, 1402);
});

t('garbage returns null rather than nonsense', () => {
  eq(readImageSize(Buffer.alloc(64)), null);
  eq(readImageSize(Buffer.from('not an image at all')), null);
});

// ------------------------------------------------- REGRESSION: real failures
console.log('\nregression - four real failed posts, real dimensions, real errors');

await ta('800452 TikTok 1122x1402 -> caught (platform said "Unsupported picture size")', async () => {
  const res = await validatePost({ platform: 'tiktok', mediaUrls: ['x'], probes: [probe(1122, 1402)] });
  const b = blocking(res);
  truthy(b.length >= 1, 'expected a blocking finding');
  truthy(/short edge/i.test(b[0].message), 'should name the short edge as the cause');
  truthy(/1080 x 1350/.test(b[0].fix), 'fix should give concrete dimensions');
});

await ta('793073 TikTok 1092x1440 -> caught', async () => {
  const res = await validatePost({ platform: 'tiktok', mediaUrls: ['x'], probes: [probe(1092, 1440)] });
  truthy(blocking(res).length >= 1);
});

await ta('762010 TikTok 1122x1402 -> caught', async () => {
  const res = await validatePost({ platform: 'tiktok', mediaUrls: ['x'], probes: [probe(1122, 1402)] });
  truthy(blocking(res).length >= 1);
});

await ta('754549 TikTok 1080x1350 -> NOT a size failure (it failed on media fetch)', async () => {
  // The discriminating case. If this one trips the size rule, the rule is wrong -
  // the platform did NOT report a size problem for it.
  const res = await validatePost({ platform: 'tiktok', mediaUrls: ['x'], probes: [probe(1080, 1350)] });
  eq(blocking(res).length, 0, 'short edge exactly 1080 must pass');
});

await ta('754549 the real cause: an unfetchable URL is a blocking failure', async () => {
  const res = await validatePost({
    platform: 'tiktok',
    mediaUrls: ['x'],
    probes: [probe(0, 0, { status: 403, ok: false, width: null, height: null, error: 'HTTP 403' })],
  });
  const b = blocking(res);
  truthy(b.length >= 1);
  truthy(/did not serve/i.test(b[0].message), 'should name the fetch failure');
});

// --------------------------------------------------------------- rule checks
console.log('\nrules');

await ta('total pixels alone does NOT trip TikTok - the dead hypothesis stays dead', async () => {
  // 1122x1402 is 1,573,044 px, well under 2,073,600. If the tool ever starts
  // blaming total pixels, this is the test that catches the regression.
  const res = await validatePost({ platform: 'tiktok', mediaUrls: ['x'], probes: [probe(1122, 1402)] });
  const msgs = blocking(res).map((f) => f.message).join(' ');
  truthy(!/2,073,600 pixels is over/i.test(msgs));
  truthy(/short edge/i.test(msgs));
});

await ta('TikTok rejects a PNG even when the URL ends .jpeg', async () => {
  const res = await validatePost({
    platform: 'tiktok',
    mediaUrls: ['https://example.com/looks-fine.jpeg'],
    probes: [probe(1080, 1350, { format: 'png' })],
  });
  const b = blocking(res);
  truthy(b.some((f) => /actually PNG/i.test(f.message)), 'must judge by header, not extension');
});

await ta('X caption over 280 is blocking and names the overage', async () => {
  const res = await validatePost({ platform: 'twitter', text: 'a'.repeat(300) });
  const b = blocking(res);
  eq(b.length, 1);
  truthy(/20 over/.test(b[0].message), 'should say how many characters over');
});

await ta('X allows at most 4 images', async () => {
  const res = await validatePost({
    platform: 'twitter',
    mediaUrls: ['a', 'b', 'c', 'd', 'e'],
    probes: Array.from({ length: 5 }, () => probe(1600, 900)),
  });
  truthy(blocking(res).some((f) => /over the 4 allowed/.test(f.message)));
});

await ta('Instagram pixel ceiling WARNS, it does not block (Blotato downscales)', async () => {
  const res = await validatePost({ platform: 'instagram', mediaUrls: ['x'], probes: [probe(1440, 1800)] });
  const warns = res.findings.filter((f) => f.severity === 'warn');
  truthy(warns.some((f) => /pixels, over/.test(f.message)), 'expected a pixel warning');
  truthy(res.ok, 'should still be publishable');
});

await ta('Facebook over 8 MB BLOCKS (validation rejects, no conversion)', async () => {
  const res = await validatePost({
    platform: 'facebook',
    mediaUrls: ['x'],
    probes: [probe(1080, 1350, { bytes: 9 * 1024 * 1024 })],
  });
  truthy(blocking(res).some((f) => /over the 8\.0 MB/.test(f.message)));
});

await ta('Instagram carousel over 10 items blocks', async () => {
  const res = await validatePost({
    platform: 'instagram',
    mediaUrls: Array.from({ length: 11 }, (_, i) => String(i)),
    probes: Array.from({ length: 11 }, () => probe(1080, 1080)),
  });
  truthy(blocking(res).some((f) => /over the 10 allowed/.test(f.message)));
});

await ta('unknown platform fails loudly instead of silently passing', async () => {
  const res = await validatePost({ platform: 'myspace', mediaUrls: [] });
  eq(res.ok, false);
  truthy(/No rules for platform/.test(res.findings[0].message));
});

await ta('every finding carries a fix', async () => {
  const res = await validatePost({
    platform: 'tiktok',
    text: 'a'.repeat(3000),
    mediaUrls: ['x'],
    probes: [probe(1500, 2000)],
  });
  truthy(res.findings.length >= 2);
  for (const f of res.findings) truthy(f.fix, `finding without a fix: ${f.message}`);
});

// ------------------------------------------------------------- MCP handshake
console.log('\nMCP - the server actually speaks the protocol');

await ta('initialize, tools/list and tools/call over stdio', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const server = path.join(here, '..', 'src', 'mcp-server.js');
  const proc = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });

  const replies = [];
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) replies.push(JSON.parse(line));
    }
  });

  const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' }); // no id: must NOT be answered
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'preflight_check', params: {}, arguments: { platforms: ['twitter'], text: 'a'.repeat(300) } },
  });

  await new Promise((r) => setTimeout(r, 1800));
  proc.stdin.end();
  proc.kill();

  const init = replies.find((r) => r.id === 1);
  truthy(init?.result?.serverInfo?.name === 'blotato-preflight', 'initialize must identify the server');

  const list = replies.find((r) => r.id === 2);
  const names = (list?.result?.tools || []).map((t) => t.name);
  truthy(names.includes('preflight_check'), 'tools/list must advertise preflight_check');
  truthy(names.includes('preflight_rules'), 'tools/list must advertise preflight_rules');

  const call = replies.find((r) => r.id === 3);
  const text = call?.result?.content?.[0]?.text || '';
  truthy(/VERDICT: 1 blocking/.test(text), `tools/call should report the 280 breach, got: ${text.slice(0, 160)}`);

  // the protocol rule that is easy to get wrong
  eq(replies.filter((r) => r.id === undefined).length, 0, 'server must never reply to a notification');
});

// ------------------------------------------------------------------- summary
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
