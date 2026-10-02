# The signature layout probe

A test that can see the screen.

Everything else in this repo tests logic. Nothing in it could see that the
Add Signature sheet was drawing its signing canvas off the bottom of the
phone — which is why that bug was diagnosed, fixed, reviewed, merged and
shipped three times while remaining broken on the device. This probe exists
so that the fourth attempt could be proved rather than believed.

## How to run it

One command, from the repo root:

```
./Projects/apps/mobile/scripts/signature-probe.sh
```

It starts everything it needs, prints a report, and stops what it started.
It exits 0 when the sheet is correct and non-zero when it is not.

The report looks like this:

```
--- pass 1: keyboard closed ---
  window: 402 x 874
  canvas   x=20 y=772 w=362 h=160 bottom=932
  [FAIL] canvas is fully inside the window
         canvas top=772 bottom=932 window h=874 -> 58pt of the canvas is BELOW the bottom edge of the screen
=> RED: 5 of 12 assertions FAILED across 2 pass(es)
```

Those are real measured positions in points, taken from the real sheet on a
running phone — not a simulation of it, and not a copy of the screen built
for testing.

### What it needs first

The **development build** of the app must be installed on the simulator. That
is a different build from the one on your phone: it loads its JavaScript from
your Mac, which is what makes the probe possible at all. If it is missing the
script says so and tells you the command to build it. A build takes around
fifteen minutes on Expo's servers; after that, re-running the probe takes
about a minute and needs no new build.

## What it measures

Six checks, run twice — once with the keyboard closed and once with it open:

1. The pad wrapper is at least as tall as the canvas inside it. **This is the
   check that catches the actual defect.** The others catch its consequences.
2. The canvas is 160pt tall, the height the sheet asks for.
3. The canvas is fully inside the screen.
4. The canvas does not overlap the Cancel/Save row.
5. The Cancel/Save row is fully inside the screen.
6. The sheet's card bottom is inside the screen.

### It will not quietly pass

Two things that would otherwise make a green result meaningless:

- **A run with no checks in it is a failure, not a pass.** If the probe reaches
  the end having measured nothing, it reports RED.
- **A pass that could not run is reported as NOT RUN, never as a pass.** If the
  keyboard never appears, the keyboard-open pass says so in the report and is
  excluded from the count.

## What it can never see

Read this part. A green report is narrower than it looks.

- **One iOS version.** This Mac has iOS 26.5 installed and nothing else. A bug
  that only appears on iOS 25, or on a future 27, is invisible to this probe by
  construction — not unlikely to be caught, *impossible* to be caught.
- **One screen size.** It measures whichever simulator is booted. A different
  phone is a different measurement and is not covered by a green run here.
- **Nothing about the server, the database, or saving.** The probe drives the
  sheet with invented data and never saves a signature. A green report says the
  sheet is laid out correctly. It says nothing about whether signing works end
  to end, whether the signature is stored, or whether the API accepts it.
- **Only this one screen.** It is a probe for the Add Signature sheet, not a
  test suite for the app.
- **Nothing a human would call ugly.** It checks positions, not design.

### A correction worth recording

It has been stated, including in the instructions this work was done under,
that the development client points at `http://localhost:4000` with an
in-memory store. **That was not true.** `Projects/apps/mobile/.env` contains:

```
EXPO_PUBLIC_API_URL=https://sitesap-ai.onrender.com
```

so a dev client started without an override talks to **production**. The run
that produced the first red report did exactly that, and logged
`Resolved base URL: https://sitesap-ai.onrender.com`.

`scripts/signature-probe.sh` now sets `EXPO_PUBLIC_API_BASE_URL` — which
`lib/api-base-url.ts` checks *before* `EXPO_PUBLIC_API_URL` — to the local API
it starts itself, so the probe cannot touch production. The `.env` default is
unchanged and still points at production for anyone starting Metro by hand.

## Why the probe is not in the app you ship

The probe code is development-only, and that is enforced by how it is loaded,
not by intention. **This detail is load-bearing and easy to destroy by
tidying it up.**

In `components/SignaturePad.tsx` and `app/inspections/[siteId].tsx`:

```ts
let DevProbe: typeof import("@/lib/dev-signature-probe") | null = null;
if (__DEV__) {
  DevProbe = require("@/lib/dev-signature-probe");
}
```

That `require` must stay inside the `if`. Converting it to a normal top-level
`import` would ship the entire probe to customers while *looking* identical,
because Metro does not tree-shake: it bundles every statically imported
module whether or not anything reachable calls it.

This was measured, not assumed. Building a production bundle
(`NODE_ENV=production npx expo export --platform ios`) and searching the
resulting Hermes bytecode for strings that exist only in the probe:

| how the probe is loaded | probe strings in the production bundle |
|---|---|
| top-level `import`, call site gated by `__DEV__` | **present** |
| `require()` inside `if (__DEV__)` | **absent** |

Every "absent" result above was checked against a control string from the same
file that is *not* dev-gated, which was present — otherwise a file that simply
never got bundled would look like proof of stripping. (That exact false
positive happened once: `components/ErrorFallback.tsx` is never imported
anywhere, so grepping it proved nothing.)

To re-verify after changing any of this:

```
cd Projects/apps/mobile
NODE_ENV=production npx expo export --platform ios --output-dir /tmp/bundle --clear
strings -a /tmp/bundle/_expo/static/js/ios/entry-*.hbc | grep -c -F "SIGPROBE_REPORT_BEGIN"
```

That must print `0`.

## How it avoids changing what it measures

A probe that moves the thing it is measuring is worse than no probe. So:

- It adds **no wrapping views and no style changes**. It attaches references to
  views that already existed and reads their positions with `measureInWindow`.
- The report overlay is `position: "absolute"`, which Yoga excludes from layout
  entirely, and `pointerEvents="none"`, so it cannot intercept the drawing
  gesture.
- The keyboard-closed pass is measured **before the overlay exists in the tree
  at all**, so for that pass the probe provably could not have affected the
  numbers it read.
