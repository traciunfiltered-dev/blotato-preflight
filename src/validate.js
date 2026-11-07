/**
 * The engine. Takes a post, returns findings.
 *
 * DESIGN RULE: every finding carries four things, and the fourth is the one most
 * validators skip.
 *   severity - 'fail' means the platform will reject it, 'warn' means it will
 *              publish but something will be changed or degraded.
 *   message  - what is wrong, with the actual numbers in it.
 *   source   - where the limit comes from, so the tool can be argued with.
 *   fix      - WHAT TO DO. A validator that tells you a post is broken and not
 *              how to unbreak it has moved the work, not done it.
 *
 * The fail/warn split is not cosmetic. Over Instagram's pixel ceiling, Blotato
 * downscales for you and the post goes out - that is a warn. Over Facebook's 8 MB,
 * validation rejects it - that is a fail. Treating those the same would train
 * someone to ignore the output, which is the only way a checker truly fails.
 */

import { RULES, MULTI_IMAGE } from './rules.js';
import { probeAll } from './probe.js';

const fmtBytes = (n) =>
  n == null ? 'unknown' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

/**
 * @param {{platform:string, text?:string, mediaUrls?:string[], probes?:any[]}} post
 */
export async function validatePost(post) {
  const platform = String(post.platform || '').toLowerCase();
  const rules = RULES[platform];
  if (!rules) {
    return {
      platform,
      ok: false,
      findings: [
        {
          severity: 'fail',
          message: `No rules for platform "${platform}". Known: ${Object.keys(RULES).join(', ')}`,
          source: 'this tool',
          fix: 'Check the platform name, or add it to src/rules.js.',
        },
      ],
      probes: [],
    };
  }

  const findings = [];
  const text = post.text || '';
  const urls = post.mediaUrls || [];

  // ---- text ----
  if (rules.text && text.length > rules.text.max) {
    findings.push({
      severity: 'fail',
      message: `Caption is ${text.length} characters, ${text.length - rules.text.max} over the ${rules.text.max} limit.`,
      source: rules.text.source,
      fix: `Cut ${text.length - rules.text.max} characters.${platform === 'twitter' ? ' Or split it into a thread with additionalPosts.' : ''}`,
    });
  }

  // ---- media count ----
  if (urls.length > 1 && !MULTI_IMAGE.has(platform)) {
    findings.push({
      severity: 'warn',
      message: `${urls.length} media items given, but ${rules.label} posts take one.`,
      source: 'this tool, from the per-platform media rules',
      fix: 'Send the first image only, or split into separate posts.',
    });
  }
  if (rules.media?.maxImages && urls.length > rules.media.maxImages) {
    findings.push({
      severity: 'fail',
      message: `${urls.length} images, over the ${rules.media.maxImages} allowed.`,
      source: rules.media.source,
      fix: `Drop to ${rules.media.maxImages}.`,
    });
  }
  if (rules.carousel && urls.length > rules.carousel.max) {
    findings.push({
      severity: 'fail',
      message: `${urls.length} carousel items, over the ${rules.carousel.max} allowed.`,
      source: rules.carousel.source,
      fix: `Drop to ${rules.carousel.max} items.`,
    });
  }

  // ---- media itself ----
  const probes = post.probes || (urls.length ? await probeAll(urls) : []);
  const img = rules.image || {};

  probes.forEach((p, i) => {
    const tag = probes.length > 1 ? `Image ${i + 1}/${probes.length}` : 'Image';

    if (p.status !== 200 && p.status !== 206) {
      findings.push({
        severity: 'fail',
        message: `${tag}: the URL did not serve the file (${p.error || 'HTTP ' + p.status}).`,
        source: 'fetched unauthenticated, the same way the platform fetches it',
        fix: 'Use a URL that opens with no login. This is the error that reads as "connection error while downloading the photo".',
      });
      return;
    }

    if (p.format === 'video') return; // out of scope for v1, and it says so

    if (!p.width || !p.height) {
      findings.push({
        severity: 'warn',
        message: `${tag}: could not read dimensions (${p.error || 'unknown format'}).`,
        source: 'this tool',
        fix: 'Check the file is a real JPEG, PNG, WebP, GIF or BMP.',
      });
      return;
    }

    const short = Math.min(p.width, p.height);
    const long = Math.max(p.width, p.height);
    const total = p.width * p.height;
    const dims = `${p.width} x ${p.height}`;

    // real format vs accepted formats
    if (img.formats && !img.formats.includes(p.format)) {
      findings.push({
        severity: 'fail',
        message: `${tag}: the file is actually ${p.format.toUpperCase()}. ${rules.label} takes ${img.formats.join(', ').toUpperCase()}.`,
        source: img.formatsSource,
        fix: `Re-export as ${img.formats[0].toUpperCase()}. Renaming the extension does not change the file.`,
      });
    }

    if (img.maxBytes && p.bytes && p.bytes > img.maxBytes) {
      findings.push({
        severity: 'fail',
        message: `${tag}: ${fmtBytes(p.bytes)}, over the ${fmtBytes(img.maxBytes)} limit.`,
        source: img.maxBytesSource,
        fix: 'Re-export at a lower quality setting, or resize down.',
      });
    }

    // THE TIKTOK RULE. Short edge, not total pixels.
    if (img.maxShortEdge && short > img.maxShortEdge) {
      findings.push({
        severity: 'fail',
        message: `${tag}: ${dims}. Short edge is ${short}px, over ${img.maxShortEdge}px. This is what "Unsupported picture size" means and it is NOT a total-pixel problem - ${total.toLocaleString()} pixels is well under 2,073,600.`,
        source: img.maxShortEdgeSource,
        confidence: img.maxShortEdgeConfidence,
        fix: img.recommend
          ? `Re-render at ${img.recommend.width} x ${img.recommend.height} (${img.recommend.note}). Keeping your ${(p.width / p.height).toFixed(3)} ratio, that is ${Math.round(img.maxShortEdge)} x ${Math.round((img.maxShortEdge * long) / short)}.`
          : `Resize so the short edge is ${img.maxShortEdge}px or less.`,
      });
    }

    if (img.maxLongEdge && long > img.maxLongEdge) {
      findings.push({
        severity: 'fail',
        message: `${tag}: ${dims}. Long edge is ${long}px, over ${img.maxLongEdge}px.`,
        source: img.maxLongEdgeSource,
        fix: `Resize so the long edge is ${img.maxLongEdge}px or less.`,
      });
    }

    if (img.maxTotalPixels && total > img.maxTotalPixels) {
      findings.push({
        severity: img.maxTotalPixelsSeverity === 'warn' ? 'warn' : 'fail',
        message: `${tag}: ${dims} is ${total.toLocaleString()} pixels, over ${img.maxTotalPixels.toLocaleString()}.`,
        source: img.maxTotalPixelsSource,
        fix:
          img.maxTotalPixelsSeverity === 'warn'
            ? 'It will publish, but it gets downscaled on the way. Export smaller if you want control over how.'
            : 'Resize down.',
      });
    }

    if (img.maxWidth && p.width > img.maxWidth) {
      findings.push({
        severity: 'fail',
        message: `${tag}: ${p.width}px wide, over the ${img.maxWidth}px maximum.`,
        source: img.widthSource,
        fix: `Resize to ${img.maxWidth}px wide or less.`,
      });
    }
    if (img.minWidth && p.width < img.minWidth) {
      findings.push({
        severity: img.minWidthSeverity === 'warn' ? 'warn' : 'fail',
        message: `${tag}: ${p.width}px wide, under the ${img.minWidth}px ${img.minWidthSeverity === 'warn' ? 'recommendation' : 'minimum'}.`,
        source: img.widthSource,
        fix: `Export at ${img.minWidth}px wide or more.`,
      });
    }

    if (img.aspect) {
      const r = p.width / p.height;
      if (r < img.aspect.min || r > img.aspect.max) {
        findings.push({
          severity: 'warn',
          message: `${tag}: aspect ratio ${r.toFixed(3)} is outside ${img.aspect.min.toFixed(2)} to ${img.aspect.max.toFixed(2)}.`,
          source: img.aspectSource,
          fix: 'It gets cropped to fit. Crop it yourself if you care where.',
        });
      }
    }
  });

  if (rules.carousel && urls.length === 1 && platform === 'instagram') {
    // not a finding, just not a carousel. no noise.
  }

  const fails = findings.filter((f) => f.severity === 'fail');
  return {
    platform,
    label: rules.label,
    ok: fails.length === 0,
    failCount: fails.length,
    warnCount: findings.length - fails.length,
    findings,
    probes,
  };
}

/** Same post, several platforms. Probes once and reuses them - this is the point of splitting probe out. */
export async function validateAcross(post, platforms) {
  const probes = post.mediaUrls?.length ? await probeAll(post.mediaUrls) : [];
  const results = [];
  for (const platform of platforms) {
    results.push(await validatePost({ ...post, platform, probes }));
  }
  return results;
}
