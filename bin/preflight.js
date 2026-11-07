#!/usr/bin/env node
/**
 * preflight - check a post before you schedule it.
 *
 *   preflight check   --platform tiktok --media <url,...> [--text "..."]
 *   preflight check   --all --media <url,...> [--text "..."]
 *   preflight audit   [--since ISO] [--until ISO] [--platform tiktok]
 *   preflight accounts
 *   preflight rules   [platform]
 *
 * `audit` is the one worth running first. It pulls your posts that already FAILED
 * and re-runs the checks against them, so the tool has to prove itself against
 * real failures instead of asking you to trust it.
 */

import { validatePost, validateAcross } from '../src/validate.js';
import { RULES, PLATFORMS } from '../src/rules.js';
import { BlotatoClient } from '../src/blotato.js';

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', y: '\x1b[33m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', y: '', g: '', d: '', b: '', x: '' };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function printResult(res) {
  const head = res.ok
    ? `${C.g}PASS${C.x}`
    : `${C.r}FAIL${C.x} (${res.failCount} blocking${res.warnCount ? `, ${res.warnCount} warning` : ''})`;
  console.log(`\n${C.b}${res.label || res.platform}${C.x}  ${head}`);
  if (!res.findings.length) {
    console.log(`  ${C.d}nothing to flag${C.x}`);
    return;
  }
  for (const f of res.findings) {
    const mark = f.severity === 'fail' ? `${C.r}x${C.x}` : `${C.y}!${C.x}`;
    console.log(`  ${mark} ${f.message}`);
    if (f.fix) console.log(`      ${C.b}fix:${C.x} ${f.fix}`);
    const conf = f.confidence === 'empirical' ? ` ${C.y}[empirical, not documented]${C.x}` : '';
    if (f.source) console.log(`      ${C.d}source: ${f.source}${C.x}${conf}`);
  }
}

function printProbes(probes) {
  if (!probes?.length) return;
  console.log(`\n${C.d}media inspected:${C.x}`);
  for (const p of probes) {
    const dims = p.width ? `${p.width}x${p.height}` : '?';
    const kb = p.bytes ? `${Math.round(p.bytes / 1024)}KB` : '?';
    const range = p.rangeHonoured ? 'range' : 'full';
    console.log(
      `  ${C.d}${String(p.status ?? '---').padEnd(4)} ${String(p.format ?? '?').padEnd(5)} ${dims.padEnd(11)} ${kb.padEnd(8)} ${range}  ${p.url.slice(-44)}${C.x}`,
    );
    if (p.error) console.log(`       ${C.y}${p.error}${C.x}`);
  }
}

const splitList = (v) =>
  typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

async function cmdCheck(args) {
  const media = splitList(args.media);
  const text = typeof args.text === 'string' ? args.text : '';
  if (!media.length && !text) {
    console.error('Nothing to check. Give --media <url,...> and/or --text "..."');
    process.exit(2);
  }

  const platforms = args.all
    ? PLATFORMS
    : args.platform
      ? splitList(args.platform)
      : null;
  if (!platforms) {
    console.error(`Give --platform <${PLATFORMS.join('|')}> or --all`);
    process.exit(2);
  }

  const results = await validateAcross({ text, mediaUrls: media }, platforms);
  printProbes(results[0]?.probes);
  results.forEach(printResult);

  const blocked = results.filter((r) => !r.ok);
  console.log('');
  if (blocked.length) {
    console.log(
      `${C.r}${blocked.length} of ${results.length} platform(s) would reject this:${C.x} ${blocked.map((r) => r.platform).join(', ')}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`${C.g}All ${results.length} platform(s) clear.${C.x}`);
  }
}

/**
 * The honesty test. Pull real failures, re-run the checks, and report how many the
 * tool would actually have caught. If that number is low, the tool is not good and
 * the output should say so rather than hide it.
 */
async function cmdAudit(args) {
  const client = new BlotatoClient();
  if (!client.hasKey) {
    console.error('Set BLOTATO_API_KEY first. See .env.example.');
    process.exit(2);
  }
  const since = typeof args.since === 'string' ? args.since : undefined;
  const until = typeof args.until === 'string' ? args.until : undefined;
  const platform = args.platform ? splitList(args.platform) : undefined;

  console.log(`${C.d}Fetching failed posts...${C.x}`);
  const failed = await client.allFailedPosts({ since, until, platform });
  if (!failed.length) {
    console.log(`${C.g}No failed posts in that window. Nothing to audit.${C.x}`);
    return;
  }
  console.log(`Found ${C.b}${failed.length}${C.x} failed post(s).\n`);

  let caught = 0;
  const missed = [];

  for (const post of failed) {
    const urls = post.mediaUrls || [];
    const res = await validatePost({
      platform: post.platform,
      text: post.text || '',
      mediaUrls: urls,
    });
    const would = !res.ok;
    if (would) caught++;
    else missed.push(post);

    const mark = would ? `${C.g}WOULD HAVE CAUGHT${C.x}` : `${C.r}WOULD HAVE MISSED${C.x}`;
    console.log(`${C.b}${post.id}${C.x} ${post.platform} ${String(post.postTime).slice(0, 10)}  ${mark}`);
    console.log(`  ${C.d}platform said: ${post.state?.errorMessage || '(no message)'}${C.x}`);
    for (const f of res.findings.filter((x) => x.severity === 'fail')) {
      console.log(`  ${C.g}->${C.x} ${f.message}`);
      if (f.fix) console.log(`     ${C.b}fix:${C.x} ${f.fix}`);
    }
    console.log('');
  }

  const pct = Math.round((caught / failed.length) * 100);
  console.log(`${C.b}${caught} of ${failed.length} (${pct}%) would have been caught before scheduling.${C.x}`);
  if (missed.length) {
    console.log(`\n${C.y}Not caught, and these are the ones worth reading:${C.x}`);
    for (const m of missed) {
      console.log(`  ${m.id} ${m.platform}: ${m.state?.errorMessage || '(no message)'}`);
    }
    console.log(
      `${C.d}A miss means a rule is missing, not that the post was fine. Add it to src/rules.js.${C.x}`,
    );
  }
}

async function cmdAccounts() {
  const client = new BlotatoClient();
  if (!client.hasKey) {
    console.error('Set BLOTATO_API_KEY first. See .env.example.');
    process.exit(2);
  }
  const res = await client.accounts();
  const items = res.items || res.data || res.accounts || [];
  if (!items.length) {
    console.log('No connected accounts returned.');
    return;
  }
  for (const a of items) {
    console.log(`${C.b}${String(a.platform || '?').padEnd(11)}${C.x} ${a.name || a.username || ''} ${C.d}id=${a.id}${C.x}`);
    for (const s of a.subaccounts || []) {
      console.log(`  ${C.d}subaccount: ${s.name || s.id} (id=${s.id})${C.x}`);
    }
  }
}

function cmdRules(args) {
  const only = args._[1];
  for (const [key, r] of Object.entries(RULES)) {
    if (only && key !== only) continue;
    console.log(`\n${C.b}${r.label}${C.x} (${key})`);
    if (r.text) console.log(`  text max ${r.text.max}\n    ${C.d}${r.text.source}${C.x}`);
    const i = r.image || {};
    if (i.formats) console.log(`  formats ${i.formats.join(', ')}\n    ${C.d}${i.formatsSource}${C.x}`);
    if (i.maxBytes) console.log(`  max ${(i.maxBytes / 1048576).toFixed(0)} MB\n    ${C.d}${i.maxBytesSource}${C.x}`);
    if (i.maxShortEdge)
      console.log(
        `  short edge <= ${i.maxShortEdge}px\n    ${C.y}${i.maxShortEdgeSource}${C.x}`,
      );
    if (i.maxLongEdge) console.log(`  long edge <= ${i.maxLongEdge}px\n    ${C.d}${i.maxLongEdgeSource}${C.x}`);
    if (i.maxTotalPixels)
      console.log(
        `  total pixels <= ${i.maxTotalPixels.toLocaleString()} (${i.maxTotalPixelsSeverity === 'warn' ? 'warning' : 'blocking'})\n    ${C.d}${i.maxTotalPixelsSource}${C.x}`,
      );
    if (i.recommend)
      console.log(`  ${C.g}recommended: ${i.recommend.width} x ${i.recommend.height} - ${i.recommend.note}${C.x}`);
  }
  console.log('');
}

function usage() {
  console.log(`
${C.b}preflight${C.x} - check a social post before you schedule it

  preflight check --platform tiktok --media <url,...> [--text "..."]
  preflight check --all --media <url,...> [--text "..."]
  preflight audit [--since ISO] [--until ISO] [--platform tiktok]
  preflight accounts
  preflight rules [platform]

Platforms: ${PLATFORMS.join(', ')}
Needs BLOTATO_API_KEY for 'audit' and 'accounts'. 'check' and 'rules' need nothing.
`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

try {
  if (cmd === 'check') await cmdCheck(args);
  else if (cmd === 'audit') await cmdAudit(args);
  else if (cmd === 'accounts') await cmdAccounts();
  else if (cmd === 'rules') cmdRules(args);
  else usage();
} catch (e) {
  console.error(`\n${C.r}${e.message}${C.x}`);
  process.exit(1);
}
