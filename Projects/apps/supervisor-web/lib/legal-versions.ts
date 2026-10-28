/**
 * Which version of the Terms and the Privacy Policy this portal build shows,
 * and where it shows them.
 *
 * WHY A CONSTANT HERE AND NOT A SHARED PACKAGE
 * The mobile app renders both documents from its own data modules and sends
 * `TERMS_OF_SERVICE.lastUpdated` with a signup, so the version it records is
 * the version of the text it actually displayed. The portal cannot do that,
 * because it has no copy of either document -- deliberately: it used to carry a
 * fourth copy of each at app/privacy/page.tsx and app/terms/page.tsx, they had
 * drifted into claims no other copy made, and removing them is what closed
 * AUDIT A6. It links to the hosted pages instead.
 *
 * So the version has to be stated, and the three places it could have lived
 * are all closed:
 *   - @sitesnap/shared emits .d.ts only (`"main": "dist/index.d.ts"`), so it
 *     cannot carry a runtime value at all.
 *   - docs/legal/ is outside Projects/ and is not in the Docker image.
 *   - importing the mobile app's module is banned by the lint rule that keeps
 *     apps/* out of each other.
 *
 * WHAT KEEPS IT HONEST
 * Projects/scripts/ci.sh reads the `Last updated:` line out of the canonical
 * markdown and fails the build if the string below is not it
 * (`assert_legal_version_constant`). So this is a copy that cannot drift, in
 * the same way and by the same mechanism as the other copies of that line.
 *
 * Changing a document therefore means: edit docs/legal/<doc>.md, re-render the
 * mobile module and the website page, and change the matching string here. CI
 * fails on any of the four being missed.
 */

/** The `lastUpdated` line of docs/legal/terms-of-service.md, verbatim. */
export const TERMS_VERSION = "Last updated: 3 October 2026";

/** The `lastUpdated` line of docs/legal/privacy-policy.md, verbatim. */
export const PRIVACY_VERSION = "Last updated: 4 October 2026";

/**
 * The hosted documents.
 *
 * Absolute, and on the marketing domain, because these ARE the portal's copies
 * -- there is no in-app page to route to. `website/terms/index.html` and
 * `website/privacy/index.html` are the pages behind them, and they are two of
 * the three copies ci.sh compares word-for-word.
 */
export const TERMS_URL = "https://www.getsitesnapai.com/terms";
export const PRIVACY_URL = "https://www.getsitesnapai.com/privacy";
