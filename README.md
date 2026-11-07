# blotato-preflight

Check a social post against each platform's real rules **before** you schedule it.

Zero dependencies. Runs as a command line tool or as an MCP server so an AI agent
can check its own work before it publishes anything.

---

## Why this exists

I had four TikTok posts fail. Three of them said this:

```
Tiktok post failed to publish: Unsupported picture size.
Check TikTok's Video and Photo Restrictions.
```

The posts were already scheduled. They failed silently, hours later, and I found
out by going and looking. Nothing told me at the moment I could still have fixed it.

The frustrating part is that the information needed to prevent it was sitting right
there in the file the whole time. Nobody had asked the image how big it was.

Blotato's own documentation says the thing this tool is built on:

> An `.mp4` filename does not prove the container, codecs, or aspect ratio.
> **Upload success does not establish platform compatibility.**

That gap — between "the upload worked" and "the platform will accept it" — is the
entire problem. This closes it.

---

## What it found, and how the first answer was wrong

The obvious theory was total pixel count. TikTok's limit gets described as "1080p",
Blotato downscales images over 1,920 × 1,080 = 2,073,600 pixels, so presumably my
images were too big.

**That theory was wrong.** I measured all four:

| Post | Dimensions | Total pixels | Under 2,073,600? | What the platform said |
|---|---|---|---|---|
| 800452 | 1122 × 1402 | 1,573,044 | yes | Unsupported picture size |
| 793073 | 1092 × 1440 | 1,572,480 | yes | Unsupported picture size |
| 762010 | 1122 × 1402 | 1,573,044 | yes | Unsupported picture size |
| 754549 | 1080 × 1350 | 1,458,000 | yes | *a media fetch error, not a size error* |

Every one was comfortably under the pixel ceiling. So the ceiling was not the cause,
and a tool built on that theory would have passed all four.

Look at the **short edge** instead:

- 1122 → failed
- 1092 → failed
- 1122 → failed
- **1080 → did not get a size error**

TikTok documents its image limit only as "Maximum 1080p", which is genuinely
ambiguous for a portrait image. Blotato's docs even flag the ambiguity:

> Resolution: TikTok describes its image limit as 1080p. For a portrait export, use
> 1080 × 1920. **Do not interpret 1080p as a maximum of 1080 pixels on every
> dimension.**

Reading "1080p" as *the short edge is 1080* fits all four observations and matches
what 1080p conventionally means. So that is the rule this tool enforces.

**It is labelled `empirical`, not `documented`, everywhere it appears** — in the
rule source, in the CLI output and in the MCP response. Three failures and one
non-failure on one account is a thin sample. It is the best available explanation,
not a vendor guarantee, and the tool says so every single time rather than quietly
presenting a guess as a fact.

### The practical fix

Render TikTok slides at **1080 × 1350**. Short edge exactly 1080, 4:5 portrait.

---

## Install

Needs Node 20 or newer. Nothing else — there are no dependencies to install.

```
git clone <this repo>
cd blotato-preflight
node bin/preflight.js rules tiktok
```

---

## Use it

### Check before you schedule

```
node bin/preflight.js check --platform tiktok \
  --media "https://example.com/slide1.jpeg,https://example.com/slide2.jpeg" \
  --text "Your caption here"
```

```
TikTok  FAIL (1 blocking)
  x Image 1/2: 1122 x 1402. Short edge is 1122px, over 1080px. This is what
    "Unsupported picture size" means and it is NOT a total-pixel problem -
    1,573,044 pixels is well under 2,073,600.
      fix: Re-render at 1080 x 1350 (4:5 portrait, short edge exactly 1080).
           Keeping your 0.800 ratio, that is 1080 x 1350.
      source: EMPIRICAL, n=3 failures + 1 non-failure on one account.
              [empirical, not documented]
```

Check every platform at once — the media is fetched once and reused:

```
node bin/preflight.js check --all --media "https://example.com/slide1.jpeg"
```

Exit code is `1` if anything blocking was found, so it drops into a script or a
CI step without parsing output.

### Audit what already failed

The honesty test. It pulls posts that already failed and re-runs the checks on
them, so the tool has to prove itself against real failures instead of asking to be
trusted:

```
export BLOTATO_API_KEY=...
node bin/preflight.js audit --since 2026-09-01
```

```
800452 tiktok 2026-10-17  WOULD HAVE CAUGHT
  platform said: Unsupported picture size.
  -> Image 1/5: 1122 x 1402. Short edge is 1122px, over 1080px.
     fix: Re-render at 1080 x 1350

4 of 4 (100%) would have been caught before scheduling.
```

A **miss** is reported just as loudly as a catch, because a miss means a rule is
missing. Hiding those would make the percentage meaningless.

### See the rules and where they came from

```
node bin/preflight.js rules
```

Every limit prints with the document it came from. A validator that can't tell you
why it rejected something is just an opinion in a switch statement.

---

## As an MCP server

This is the part worth having. An agent that schedules posts can check its own work
first.

```
claude mcp add --transport stdio preflight -- node /absolute/path/to/src/mcp-server.js
```

Two tools:

- **`preflight_check`** — platforms, text, mediaUrls. Returns blocking failures and
  warnings, each with its source and a fix.
- **`preflight_rules`** — the limits and where each came from, so the agent can
  answer "what is the actual limit" without inventing one.

---

## How it works

Four files, each with one job.

### `src/rules.js` — the limits
Per-platform rules. Every single one carries a `source` string, and a `confidence`
of either `documented` (quoted from a vendor doc) or `empirical` (derived from
observed failures, with the sample size stated). Mixing those two silently is how a
tool starts lying to you.

### `src/imagesize.js` — reading the header
Parses JPEG, PNG, WebP, GIF and BMP headers by hand to get the real format and
dimensions.

It reads the **bytes**, never the filename. A PNG renamed to `.jpeg` is still a PNG,
and TikTok will reject it while your file listing looks completely fine.

The JPEG parser is the fiddly one. A JPEG is a chain of segments and the dimensions
live in a Start Of Frame segment — but EXIF thumbnails and colour profiles sit in
front of it, so reading a fixed offset gets you the thumbnail's dimensions instead of
the image's. It has to walk the segment chain. There is a test with a deliberate
decoy APP1 block in front of the real frame to prove it doesn't take the bait.

### `src/probe.js` — looking at the file over the network
Fetches each media URL with `Range: bytes=0-65535` and reads the dimensions out of
just that first chunk. Checking a seven-slide carousel moves about 450 KB instead of
2 MB.

It fetches **unauthenticated, over the network, the same way the platform does** —
and that catches the fourth failure, which wasn't a size problem at all:

```
TikTok encountered a connection error while downloading the photo.
Ensure the URL is publicly accessible and retry if valid.
```

A preflight that only looked at local files would have passed that post.

### `src/validate.js` — the judging
Takes a post plus probe results, returns findings. Every finding has a severity, a
message with real numbers in it, the rule's source, and **a fix**.

The `fail` / `warn` split is load-bearing. Over Instagram's pixel ceiling, Blotato
downscales for you and the post goes out — that's a `warn`. Over Facebook's 8 MB,
validation rejects it — that's a `fail`. Treating those the same trains you to ignore
the output, which is the only way a checker truly fails.

`validate` takes probes as an argument rather than fetching them itself. That's why
the test suite runs offline and in milliseconds, and why `--all` fetches each image
once instead of once per platform.

---

## Tests

```
node test/run-tests.js
```

20 tests, no network. The ones that matter most are the regression tests: four real
failed posts with their real dimensions and the real error the platform returned,
asserting this tool reaches the same verdict. One of them asserts that 1080 × 1350
**passes** — the discriminating case. If a future rule change starts flagging that,
the rule is wrong and the suite says so.

There's also a test asserting the dead total-pixels hypothesis stays dead, and one
that drives the MCP server over stdio through a real `initialize` / `tools/list` /
`tools/call` handshake.

---

## Building the MCP server by hand

The official SDK is good and in a production team I'd use it. It's left out here
because zero dependencies was the rule, and more honestly because writing it by hand
is the only way to actually learn what MCP is.

It turns out to be smaller than its reputation: newline-delimited JSON-RPC 2.0 over
stdin and stdout, with four messages that matter — `initialize`,
`notifications/initialized`, `tools/list`, `tools/call`.

Two things cost me real time:

**1. stdout is the transport.** One stray `console.log` puts a non-JSON line in the
stream and the client drops the connection with no useful error. Every diagnostic in
this project goes to stderr. This is the most common way a hand-rolled MCP server
fails and it is invisible until you look at the raw stream.

**2. A notification has no `id`, and replying to one is a protocol error.** The check
has to be `msg.id === undefined`, not `!msg.id` — because id `0` is valid and falsy.
That bug stays hidden until the one client whose ids start at zero connects. There's
a test asserting the server never emits a reply without an id.

---

## What it does not do

- **Video is not inspected.** It's detected and skipped with a note. Container,
  codecs, bitrate and duration need a real media probe, which would mean a
  dependency. The rules for video are in `rules.js` as reference but are not enforced.
- **Threads, Bluesky and YouTube are not covered yet.** Six platforms are.
- **The `audit` and `accounts` commands have not been exercised against a live key.**
  They're written against the published OpenAPI schema — `GET /v2/posts` and
  `GET /v2/users/me/accounts`, auth via the `blotato-api-key` header — and the
  response shapes are handled defensively, but saying they're tested would be a lie.
  The validation core, which is the part that matters, is fully tested against real
  data.
- **The TikTok short-edge rule is `n=4`.** Stated everywhere it appears.

---

## A note on the API client

`src/blotato.js` issues **GET requests only**, and `request()` hard-rejects any other
method.

The Blotato API can create posts and buy credits (`POST /v2/credits`). A preflight
tool has no business doing either, and a tool holding an API key should not be one
keystroke away from spending money. There is no POST path in the file at all. That's
a deliberate guard, not an oversight.

The key is read from `BLOTATO_API_KEY` and never written to disk. See `.env.example`.

Base URL is `https://backend.blotato.com/v2`. Blotato's docs specifically warn that
`api.blotato.com` is not valid and that AI tools guess it wrong, so it's a named
constant with that note attached.

---

## License

MIT
