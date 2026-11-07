/**
 * Platform rules, each one carrying the source it came from.
 *
 * WHY EVERY RULE HAS A `source`:
 * A validator that cannot tell you where a limit came from is just someone's
 * opinion in a switch statement. When a rule here fires, the message points at
 * the document that says so, so you can go argue with the document instead of
 * with the tool.
 *
 * CONFIDENCE LEVELS, and this matters more than it looks:
 *   'documented' - stated in a vendor doc, quoted in the comment.
 *   'empirical'  - derived from observed real failures. Says so, says the sample
 *                  size, and is never presented as if it were documented.
 * Mixing those two silently is how a tool starts lying to you.
 */

const PX = (w, h) => w * h;

export const PLATFORMS = ['tiktok', 'instagram', 'facebook', 'linkedin', 'twitter', 'pinterest'];

export const RULES = {
  tiktok: {
    label: 'TikTok',
    text: {
      max: 2200,
      source: 'Blotato platform media requirements: "Character Limit: The character limit is 2200 characters."',
      confidence: 'documented',
    },
    image: {
      formats: ['jpeg', 'jpg', 'webp'],
      formatsSource:
        'TikTok Content Posting API media transfer guide, image restrictions: supported formats "WebP" and "JPEG". Blotato echoes this and requests JPEG conversion for other formats.',
      maxBytes: 20 * 1024 * 1024,
      maxBytesSource: 'TikTok: "Maximum of 20MB for each image."',

      /**
       * THE RULE THAT ACTUALLY MATTERS, AND THE ONE EVERY OTHER TOOL GETS WRONG.
       *
       * TikTok documents picture size as only "Maximum 1080p". That is ambiguous
       * for a portrait still, and Blotato's own docs flag the ambiguity directly:
       *   "Resolution: TikTok describes its image limit as 1080p. For a portrait
       *    export, use 1080 x 1920. Do not interpret 1080p as a maximum of 1080
       *    pixels on every dimension."
       *
       * So what is the real constraint? Derived from four real failed posts on one
       * account (ids 800452, 793073, 762010, 754549):
       *
       *   1122 x 1402  short edge 1122  -> FAILED "Unsupported picture size"
       *   1092 x 1440  short edge 1092  -> FAILED "Unsupported picture size"
       *   1122 x 1402  short edge 1122  -> FAILED "Unsupported picture size"
       *   1080 x 1350  short edge 1080  -> did NOT get that error (failed on a
       *                                    media-fetch error instead)
       *
       * Every "Unsupported picture size" had a SHORT EDGE over 1080. The one at
       * exactly 1080 did not. All four were WELL UNDER 1920x1080 = 2,073,600 total
       * pixels, so a total-pixel ceiling does NOT explain these failures - that
       * hypothesis was tested first and it died.
       *
       * Reading "1080p" as "the short edge is 1080 lines" is also the conventional
       * meaning of the term, which is reassuring but is not proof.
       *
       * SAMPLE SIZE IS THREE FAILURES AND ONE NON-FAILURE. That is thin. It is
       * reported as empirical for exactly that reason.
       */
      maxShortEdge: 1080,
      maxShortEdgeSource:
        'EMPIRICAL, n=3 failures + 1 non-failure on one account. TikTok documents only "Maximum 1080p", which is ambiguous for portrait stills.',
      maxShortEdgeConfidence: 'empirical',

      maxLongEdge: 1920,
      maxLongEdgeSource:
        'Blotato guidance "For a portrait export, use 1080 x 1920", read as the long edge ceiling.',
      maxLongEdgeConfidence: 'documented',

      recommend: { width: 1080, height: 1350, note: '4:5 portrait, short edge exactly 1080' },
    },
  },

  instagram: {
    label: 'Instagram',
    text: {
      max: 2200,
      source: 'Blotato: "Instagram captions are limited to 2200 characters."',
      confidence: 'documented',
    },
    image: {
      formats: ['jpeg', 'jpg', 'png'],
      formatsSource: 'Blotato: Instagram image format "JPEG, PNG".',
      maxBytes: 8 * 1024 * 1024,
      maxBytesSource: 'Blotato: Instagram image "File Size: Maximum of 8 MB".',
      maxTotalPixels: PX(1920, 1080),
      maxTotalPixelsSource:
        'Blotato: the converter "downscales images above 2,073,600 pixels". Over this is a warning, not a failure - Blotato downscales it for you.',
      maxTotalPixelsSeverity: 'warn',
      minWidth: 320,
      maxWidth: 1440,
      widthSource: 'Blotato: "Export Width: 320 to 1440 pixels."',
      aspect: { min: 4 / 5, max: 1.91 },
      aspectSource: 'Blotato: "Export Aspect Ratio: 4:5 to 1.91:1 for feed images."',
      recommend: { width: 1080, height: 1080, note: '1:1 square uses the most feed area' },
    },
    carousel: {
      min: 2,
      max: 10,
      source: 'Blotato: carousel "Number of Items: 2 to 10."',
      confidence: 'documented',
    },
  },

  facebook: {
    label: 'Facebook',
    text: {
      max: 63206,
      source: 'Blotato: Facebook Graph API "Max character limit is 63,206 characters".',
      confidence: 'documented',
    },
    image: {
      formats: ['jpeg', 'jpg', 'png', 'gif', 'bmp', 'tiff'],
      formatsSource: 'Blotato: Facebook "Supported Formats: JPEG, PNG, GIF, BMP, and TIFF."',
      maxBytes: 8 * 1024 * 1024,
      maxBytesSource:
        'Blotato: "Images above 8 MB fail validation." This one is a hard failure, not a conversion.',
      minWidth: 1080,
      minWidthSeverity: 'warn',
      widthSource: 'Blotato: "Recommended Resolution: At least 1080 pixels wide." Recommended, so a warning.',
      recommend: { width: 1080, height: 1350, note: '4:5 portrait' },
    },
  },

  linkedin: {
    label: 'LinkedIn',
    text: {
      max: 3000,
      source: 'Blotato: "LinkedIn allows up to 3000 characters per post."',
      confidence: 'documented',
    },
    image: {
      formats: ['jpeg', 'jpg', 'png', 'gif'],
      formatsSource: 'Blotato: LinkedIn "Supported Formats: JPG, GIF, and PNG."',
      maxBytes: 5 * 1024 * 1024,
      maxBytesSource: 'Blotato: LinkedIn "Images must be <= 5 MB."',
      maxTotalPixels: 36152320,
      maxTotalPixelsSource: 'Blotato: LinkedIn "Images should have less than 36,152,320 pixels."',
      recommend: { width: 1200, height: 627, note: '1.91:1, LinkedIn\'s own display recommendation' },
    },
  },

  twitter: {
    label: 'X / Twitter',
    text: {
      max: 280,
      source: 'Blotato: "280 characters per post. Use additionalPosts for a thread."',
      confidence: 'documented',
    },
    image: {
      formats: ['jpeg', 'jpg', 'png', 'gif', 'webp'],
      formatsSource: 'Blotato: X "Supported Formats: JPG, PNG, GIF, WEBP."',
      maxBytes: 5 * 1024 * 1024,
      maxBytesSource: 'Blotato: X "Images must be <= 5 MB".',
      recommend: { width: 1600, height: 900, note: '16:9' },
    },
    media: {
      maxImages: 4,
      source: 'Blotato: "up to 4 photos, 1 animated GIF, or 1 video in a single Tweet."',
      confidence: 'documented',
    },
  },

  pinterest: {
    label: 'Pinterest',
    text: {
      max: 800,
      source: 'Blotato: Pinterest "Description Character Limit: 800 characters."',
      confidence: 'documented',
    },
    image: {
      formats: ['jpeg', 'jpg', 'png'],
      formatsSource: 'Blotato: Pinterest "Supported Formats: PNG, JPEG."',
      maxBytes: 20 * 1024 * 1024,
      maxBytesSource: 'Blotato: Pinterest "File Size: Maximum of 20 MB per image."',
      recommend: { width: 1000, height: 1500, note: '2:3, the Pinterest standard' },
    },
  },
};

/** Platforms that accept more than one image in a single post. */
export const MULTI_IMAGE = new Set(['tiktok', 'instagram', 'twitter']);
