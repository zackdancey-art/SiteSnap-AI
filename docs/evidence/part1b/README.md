# Part 1b — browser evidence

Captured 5 October 2026 in **real Chrome** (Playwright `channel: "chrome"`, headless),
viewport **390 × 844**, `deviceScaleFactor: 2`, `isMobile`/`hasTouch` — the phone
width named in the task. Logged in as a real manager against real production data.

These exist because the previous round verified responsive work by grepping the
**emitted minified stylesheet**. That method proves a rule was emitted. It cannot
prove a page renders, and the settings overlay below is precisely the class of
defect it was structurally incapable of catching.

## Item 3 — Settings overlay

| File | What it shows |
|---|---|
| `before-settings-list-390.png` | The settings list as shipped. |
| `before-settings-notifications-390.png` | **The defect.** After tapping Notifications, the nav card is painted *over* the panel. The giveaway is the stray toggle beside "Sign Out" — it belongs to the panel row underneath. |
| `after-settings-list-390.png` | The list after the fix. |
| `after-settings-notifications-390.png` | The panel below the nav, no overlap. All ten nav items present, full width. |

Measured in the same run, same element pair (`getBoundingClientRect`):

```
before: grid, rows 248.625px / 423.375px, nav natural height 392px
        -> nav overflows its row by 143px and paints over its sibling
after:  flex column, NAV h=392 (top 140, bottom 389), DIV h=423 (top 405, bottom 828)
        OVERLAP PX: 0
```

Note the intermediate state, because it is the point of the whole exercise:
`display: flex` alone brought OVERLAP to **0** while the nav was still
half-width and still clipping six of its ten items. The number said fixed. The
screenshot said otherwise. See `globals.css` for why `align-items` flips meaning
between the grid and flex layouts.

## Item 1 — Cross-Origin-Resource-Policy

`corp-ab-control.png` is the proof, and it is a **controlled A/B on one server**
rather than a before/after across two deploys:

- Document at `http://localhost:3001`; both images requested from `http://localhost:4000`.
  Cross-origin, and same-*site* in the sense CORP uses, exactly as
  `app.getsitesnapai.com` → `api.getsitesnapai.com`.
- **A** — the uploads route, carrying the fix: `200`, `cross-origin-resource-policy: same-site`,
  `naturalWidth: 3024`, photograph renders.
- **B** — `/assets/logo.png`, deliberately untouched: `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`,
  `naturalWidth: 0`, broken-image icon.

Only the header differs. B doubles as proof that the fix is **scoped to the
uploads route** and did not relax Helmet globally.

## What `after-site-photos-390.png` does and does not prove

It was captured against the **production** API through a Playwright route shim
(needed because production CORS correctly refuses `http://localhost:3002`).

**It is not CORP evidence, in either direction.** Tested rather than assumed: the
run was repeated with the shim rewriting CORP to `same-site` and without, and the
render count was **identical (7 of 16)** while the shim logged `UPSTREAM 200
corp=same-origin` on all eight uploads responses. Playwright's `route.fulfill`
serves the body from the browser process, downstream of the network-service check
that enforces CORP — so **any CORP test run through an interception harness is a
false pass.** Worth knowing before anyone reaches for this harness again.

What it *does* prove, end to end against production: the row exists, the object
exists, the URL signs, the request returns **200 with real JPEG bytes**
(`content-length: 1629558`, `content-type: image/jpeg`), the CSP permits the
origin, and the portal decodes and lays out the image at its natural
`3024 × 4032`. Every link in the chain except the one the A/B covers.

Two incidental observations from this capture:

- The photographs show a **steel portal-frame building, not a bridge** — the same
  record discrepancy the generated report flagged independently.
- "7 of 16" is bandwidth, not blocking: `UPLOAD FAILURES 0`. The Photos tab
  requests the **full-resolution originals** (3024 × 4032, ~1.6 MB each) as grid
  thumbnails — roughly 26 MB for one tab on a phone. There is no thumbnailing.
