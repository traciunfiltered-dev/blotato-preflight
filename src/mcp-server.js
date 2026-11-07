#!/usr/bin/env node
/**
 * An MCP server for preflight, written against the wire protocol directly.
 *
 * WHY NO SDK:
 * The official SDK is good and in a production team I would use it. It is left out
 * here for two reasons. First, zero dependencies was the rule for the whole project.
 * Second, and more honestly: writing it by hand is the only way to actually learn
 * what MCP is. It turns out to be smaller than its reputation - newline-delimited
 * JSON-RPC 2.0 over stdin and stdout, with four messages that matter.
 *
 * THE FOUR MESSAGES:
 *   initialize                  -> answer with protocol version + capabilities
 *   notifications/initialized   -> a notification. NO id, so send NO reply.
 *   tools/list                  -> the tools and their JSON Schemas
 *   tools/call                  -> run one, return content blocks
 *
 * THE TWO THINGS THAT WILL BITE YOU, both learned the hard way:
 *
 * 1. NEVER WRITE TO STDOUT EXCEPT PROTOCOL FRAMES. stdout IS the transport. A
 *    stray console.log puts a non-JSON line in the stream and the client drops the
 *    connection with no useful error. Every diagnostic in this file goes to
 *    stderr. This is the single most common way a hand-rolled MCP server fails.
 *
 * 2. A NOTIFICATION HAS NO `id`, AND REPLYING TO ONE IS A PROTOCOL ERROR. The
 *    check is `msg.id === undefined`, not `!msg.id` - because id 0 is valid and
 *    falsy, and that bug is invisible until the one client that starts its ids at
 *    zero connects.
 *
 * Run it:  node src/mcp-server.js
 * Wire it: claude mcp add --transport stdio preflight -- node /abs/path/src/mcp-server.js
 */

import { validatePost, validateAcross } from './validate.js';
import { RULES, PLATFORMS } from './rules.js';

const PROTOCOL_VERSION = '2025-06-18';
const log = (...a) => process.stderr.write(`[preflight-mcp] ${a.join(' ')}\n`);

const TOOLS = [
  {
    name: 'preflight_check',
    description:
      'Check a social post against one or more platforms BEFORE scheduling it. Inspects each media URL over the network the way the platform will (real format from the file header, dimensions, byte size, and whether the URL is publicly fetchable) and checks caption length. Returns blocking failures and warnings, each with the source of the rule and a concrete fix. Use this before any call that schedules or publishes a post.',
    inputSchema: {
      type: 'object',
      properties: {
        platforms: {
          type: 'array',
          items: { type: 'string', enum: PLATFORMS },
          description: `Platforms to check. Omit to check all of: ${PLATFORMS.join(', ')}`,
        },
        text: { type: 'string', description: 'The caption or post text.' },
        mediaUrls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Publicly reachable media URLs, in post order.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'preflight_rules',
    description:
      'Return the platform rules this tool enforces, each with the document it came from and whether it is documented by the vendor or derived empirically from observed failures. Use it to answer "what is the actual limit for X" without guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: PLATFORMS, description: 'Omit for all platforms.' },
      },
      additionalProperties: false,
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

/** Render findings as text a model can act on without re-parsing JSON. */
function renderResults(results) {
  const lines = [];
  let fails = 0;
  for (const r of results) {
    const blocking = r.findings.filter((f) => f.severity === 'fail');
    fails += blocking.length;
    lines.push(`${r.label || r.platform}: ${r.ok ? 'PASS' : `FAIL (${blocking.length} blocking)`}`);
    for (const f of r.findings) {
      lines.push(`  [${f.severity.toUpperCase()}] ${f.message}`);
      if (f.fix) lines.push(`    FIX: ${f.fix}`);
      if (f.source) {
        lines.push(`    SOURCE: ${f.source}${f.confidence === 'empirical' ? ' (EMPIRICAL, not vendor-documented)' : ''}`);
      }
    }
  }
  lines.unshift(
    fails === 0
      ? 'VERDICT: clear to schedule.'
      : `VERDICT: ${fails} blocking problem(s). Do not schedule until fixed.`,
    '',
  );
  return lines.join('\n');
}

async function callTool(name, args) {
  if (name === 'preflight_check') {
    const platforms = args?.platforms?.length ? args.platforms : PLATFORMS;
    const unknown = platforms.filter((p) => !RULES[p]);
    if (unknown.length) throw new Error(`Unknown platform(s): ${unknown.join(', ')}`);

    const results = await validateAcross(
      { text: args?.text || '', mediaUrls: args?.mediaUrls || [] },
      platforms,
    );
    const probes = results[0]?.probes || [];
    const probeText = probes.length
      ? '\n\nMedia inspected:\n' +
        probes
          .map(
            (p) =>
              `  HTTP ${p.status ?? '?'} ${p.format ?? '?'} ${p.width ? `${p.width}x${p.height}` : '?'} ${p.bytes ? Math.round(p.bytes / 1024) + 'KB' : '?'}${p.error ? ` - ${p.error}` : ''}`,
          )
          .join('\n')
      : '';
    return { content: [{ type: 'text', text: renderResults(results) + probeText }] };
  }

  if (name === 'preflight_rules') {
    const subset = args?.platform ? { [args.platform]: RULES[args.platform] } : RULES;
    if (args?.platform && !RULES[args.platform]) throw new Error(`Unknown platform: ${args.platform}`);
    return { content: [{ type: 'text', text: JSON.stringify(subset, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handle(msg) {
  const { id, method, params } = msg;

  // A notification carries no id. Do the work, say nothing back.
  // `=== undefined` on purpose: id 0 is legal and falsy.
  const isNotification = id === undefined;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'blotato-preflight', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    log('client ready');
    return; // correct: no reply to a notification
  }
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      return ok(id, result);
    } catch (e) {
      // A tool that failed is a RESULT with isError, not a JSON-RPC error. The
      // model should see the message and be able to fix its own call.
      return ok(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (method === 'ping') return ok(id, {});

  if (!isNotification) err(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
process.stdin.on('data', async (chunk) => {
  buffer += chunk.toString('utf8');
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('dropped a line that was not JSON');
      continue;
    }
    try {
      await handle(msg);
    } catch (e) {
      log('handler threw:', e.message);
      if (msg.id !== undefined) err(msg.id, -32603, e.message);
    }
  }
});

process.stdin.on('end', () => process.exit(0));
log('listening on stdio');
