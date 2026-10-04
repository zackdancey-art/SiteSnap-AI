# Part 1b — review

Branch `fix/portal-photos-reports-settings`, four commits off `main`. 5 October 2026.

---

## What was fixed, and how

### Item 1 — `Cross-Origin-Resource-Policy` blocked every photograph (`e9449e6`)

`Cross-Origin-Resource-Policy: same-site`, set on the success branch of
`GET /uploads/:id/:filename` in `services/api/src/routes/uploads.ts`. **Scoped to that
route**; Helmet's global configuration in `server.ts` is untouched, so every other
response keeps the stricter `same-origin` default.

`same-site` rather than `cross-origin` because `same-site` compares scheme plus
registrable domain, which is exactly the relationship between `app.getsitesnapai.com`
and `api.getsitesnapai.com`. It permits the portal and permits nothing else.
`cross-origin` would permit any site on the internet to embed a customer's site
photographs, and the signature is a capability URL — once one leaks, `cross-origin`
is the difference between a leak and a hotlink.

**The mobile app is unaffected, and I agree with the premise.** Evidence rather than
assertion: CORP is enforced by the browser's network service against *embedded
subresources* and against nothing else. React Native's image loader is not a browser
and runs no CORP check; `apps/mobile` was never in the failing path, and no file under
`apps/mobile` was opened or changed on this branch. The second half matters as much —
CORP does not apply to **top-level navigation** either, which is precisely why pasting
a signed URL into the address bar displayed the photograph while the same URL in an
`<img>` did not. That asymmetry is the signature of this defect.

**The proof is a controlled same-server A/B**, not a before/after across two deploys —
`docs/evidence/part1b/corp-ab-control.png`. One document at `http://localhost:3001`;
both images fetched from `http://localhost:4000`. Cross-origin, and same-site in the
sense CORP uses, faithfully reproducing production.

| | Route | Status | CORP | `naturalWidth` | Rendered |
|---|---|---|---|---|---|
| **A** | `/api/uploads/:id/:file` (fixed) | 200 | `same-site` | 3024 | yes |
| **B** | `/assets/logo.png` (untouched control) | — `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` | `same-origin` | 0 | no |

Only the header differs. B simultaneously proves the fix is scoped.

The full chain, observed on **production** the same day, as observations rather than
reasoning: row exists (bootstrap returns the entry with 7 photographs) → object exists
and the URL signs (`/uploads/sign` returns a signed URL) → the request returns **`HTTP/2
200`, `content-type: image/jpeg`, `content-length: 1629558`** → the portal decodes and
lays the image out at its natural `3024 × 4032`. One and a half megabytes arrive and
are discarded by the header. The only link not covered end to end on production is CORP
itself, because this branch is not deployed — which is what the A/B covers instead.

### Item 2 — the Reports site selector (`2bf33bb`)

One `<option value="">Select a site…</option>`. The `<select>` was bound to `genSiteId`
(`""` on a normal visit) with no option carrying that value, so it displayed its first
option — a site — while its state held the empty string. Red "Please select a site."
beneath a dropdown that looked like it had one selected.

It was **unescapable**, not merely confusing: the only way to move the state off `""` is
to choose a *different* option, and with one site in the account there is none.

**It predates Part 1.** `git log -p` on that file shows the `<select>` byte-identical in
**e080ed5 (27 June 2026)**, the commit that first brought the portal into the repo.

### Item 3 — the Settings overlay (`290fac8`)

Flex column below 901px, `position: sticky` moved out of the inline style onto a
`.settings-nav` class scoped to ≥901px, plus `align-items: stretch` and
`flex-shrink: 0`. A right-edge `mask-image` fade on the nav strip and tab bar.

Cause, measured at 390×844: `.settings-layout` is the same element as `.page-body`,
which is `flex: 1 1` inside `.app-shell { height: 100dvh; overflow: hidden }` — so the
grid container had a **definite** 688px content box and distributed it across two auto
rows (`248.625px / 423.375px`) instead of growing. The content panel held at its
min-content floor; the nav did not, because its inline `overflow: hidden` gives a grid
item an **automatic minimum size of zero**, so it absorbed the remainder exactly
(`672 − 423.375 = 248.625`). Its real height is 392px. It overflowed by 143px, and the
inline `sticky` made it a stacking context that painted it over its sibling. At two
columns the rows never bind — hence invisible on every desktop check.

**The nav strip and tab bar are deliberate scrollable strips, not unintended overflow.**
Measured before deciding: sidebar `clientWidth 390 / scrollWidth 830`, tab bar
`390 / 733`, both already `overflow-x: auto`. So the right change is an affordance, and
L51's below-640px navigation is left intact rather than undone.

---

## What I found that nobody asked for

1. **A measured overlap of 0 was still broken.** `display: flex` alone brought the
   overlap to zero while the nav was **half-width** and **clipping six of its ten
   items**, Sign Out among them. Two further defects, invisible to the measurement that
   had just been declared green, visible instantly in the screenshot. `align-items:
   start` means "don't stretch down the row" in grid and "don't stretch across" in a
   flex column — same declaration, cross axis swung 90°, opposite effect. This is the
   single most useful thing in this round.

2. **A Playwright route shim silently disables CORP** (now **L55**). `route.fulfill`
   serves the body from the browser process, downstream of the check that enforces CORP.
   Proven rather than assumed: the probe was run with the shim rewriting CORP to
   `same-site` and without, render counts **identical (7 of 16)** while the shim logged
   `UPSTREAM 200 corp=same-origin` on all eight responses. Any CORP test through an
   interception harness is a false pass. I nearly shipped that screenshot as proof.

3. **The API answers a disallowed `Origin` with 500, and Sentry reports every one**
   (**L54**). `cors({ origin })` passes an `Error`, which Express renders as a 500, and
   `Sentry.setupExpressErrorHandler` sits *before* the custom error handler. Observed:
   `POST /api/auth/login` with `origin: http://localhost:3002` → **500**; identical
   request with the header removed → **200**. Not fixed — see below.

4. **The Photos tab loads full-resolution originals as thumbnails.** 3024 × 4032,
   ~1.6 MB each, 16 on this site — roughly **26 MB** for one tab on a phone. There is no
   thumbnailing. "7 of 16 rendered" in the capture is bandwidth, not blocking
   (`UPLOAD FAILURES 0`). Not recorded as a finding; flagged here.

5. **A genuine record discrepancy in the data**, surfaced by the report itself: the
   3 October photographs show a steel portal-frame building on a separate site, not the
   bridge. Independently corroborated — the same buildings are visible in the Photos tab
   screenshot. This is a customer data question, not a bug, and per standing instruction
   nothing was deleted, backfilled or cleaned up.

6. **`MEDIA_STORAGE_PROVIDER=local` does not keep you off the production bucket.**
   `useS3Storage()` returns true on that variable *or* on the mere presence of bucket and
   credential variables, which `.env` supplies. Setting the provider is not enough; the
   `S3_*`/`AWS_*`/`R2_*` variables must be explicitly blanked. This is the exact trap
   CLAUDE.md §6 records as having previously written to the real bucket.

---

## What was not done, and why

- **L54 (the CORS 500) is left open.** It is a behaviour change on a security boundary,
  it is not one of the three items, and it deserves its own commit and its own
  adversarial review rather than riding along in a PR about photographs and CSS.
- **No migration.** None was needed, as the task expected. Nothing here touches schema.
- **Nothing in `apps/mobile`.** No file under it was opened or changed.
- **The 50-entry cap could not be exercised**, and I will not claim it was. The account
  holds three entries. Separately, the portal no longer sends an `entries` array at all —
  it posts `{ siteId, period }` and the server reads the store — so the client-side cap
  is structurally unreachable from this path. That is an argument, not a test.
- **`.claude/settings.local.json` remains uncommitted**, deliberately, per standing
  instruction. It still shows as ` M`.

---

## New AUDIT entries

- **L43, sixth state** — the response is refused *after arriving*, by a header on itself,
  plus the general lesson that a browser blocks at several independent layers and
  clearing one only gives the next its turn. Also carries the security-header audit of
  the uploads response and the two corrected premises.
- **L52** — the Reports selector; predates Part 1; the second-order cost is that it is a
  defect in a *verification path*.
- **L53** — the Settings grid overlay, with the track arithmetic and the two defects a
  zero overlap did not reveal.
- **L54** — the CORS 500 and the Sentry ordering.
- **L55** — the verification method itself.

---

## What cannot be verified

- **That photographs render on production.** The CORP fix is in `services/api` and this
  branch is not deployed; production still answers `cross-origin-resource-policy:
  same-origin` (confirmed by `curl` today). This is verifiable only after the API
  deploys, and it is the one check I would ask for immediately afterwards.
- **The 50-entry cap**, as above.
- **Browsers other than Chrome.** Everything visual here is real Chrome at 390×844.
  Safari was used only for the original diagnosis.
- **Devices other than a 390×844 viewport.** A desktop-width regression check was not
  run beyond confirming the ≥901px path still receives `position: sticky`.

---

## Should the verification method change for the rest of this project?

**Yes. A real browser belongs permanently in the loop, and this is the third round of
evidence for it.**

The pattern across Parts 1 and 1b is one thing, three times: **a check that could not
fail for the reason it existed to catch.** Part 1 verified responsive work by grepping
the emitted minified stylesheet — that proves a rule was *emitted*, never that a page
*renders*, and L53 is precisely what it cannot see. Part 1 closed L45 on reasoning
because the control needed to exercise it was itself broken (L52) and nobody tried to
operate it. And in this round the obvious workaround for the CORS barrier — a route
shim — silently disabled the very header under test.

**What it would have caught**, concretely: L53 in full; the half-width nav and six
clipped items that even the correct measurement missed; L52 within seconds of loading
the Reports page; and L48 and the CORP state months earlier. **Four of the five items
across Parts 1 and 1b.** Both headline fixes from Part 1 were unverified until a browser
was opened, and one of them (L45) turned out to be genuinely working — which is the
point. Looking does not only find failures; it is the only thing that converts "should
work" into "does".

**What it costs.** Playwright plus real Chrome, headless at a fixed viewport, against a
seeded account: **60–90 seconds per run**, a one-off harness, no new production
dependency, no CI change. The real cost is not runtime — it is **auth and origin
plumbing**. A local portal cannot reach the production API without a shim, and as finding
2 above shows, the shim is exactly where the method goes quietly wrong. So the rule has
to be stated with that carve-out rather than as "just use Playwright":

> **Screenshot-and-measure for layout. A controlled same-server A/B for anything the
> browser enforces at the network layer. Never verify a security header through a
> request-interception harness.**

And one corollary, because it is what actually bit: **measure *and* look.** The overlap
measurement was correct, reported 0, and was still describing a broken page. A number
answers the question you thought to ask; a screenshot answers the ones you did not.

I would not make this a CI gate yet. It should be run by hand on every UI-affecting
branch for a few more rounds first — the failure modes of the harness itself are not
well enough understood to let it vote on a merge, which is the lesson of finding 2.
