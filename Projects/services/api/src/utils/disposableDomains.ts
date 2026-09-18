/**
 * Disposable / throwaway email domains, refused at registration.
 *
 * WHY THIS IS A DENYLIST AND NOT AN ALLOWLIST
 * A construction company's email is whatever their IT set up years ago —
 * a .co.nz, a .build, a vanity domain, a reseller's white-label host. An
 * allowlist would turn "we don't recognise your domain" into "you cannot sign
 * up", and the people it locks out are exactly the legitimate customers. A
 * denylist fails the other way: some throwaway providers get through, and the
 * cost of that is one unverified signup, not a lost customer.
 *
 * WHY IT IS A BUNDLED .ts FILE AND NOT DATA OR AN API
 *  - No network call in the signup path. A lookup service would add a
 *    third-party dependency, latency, and a new failure mode to the single most
 *    important funnel in the product — and would have to fail open to be safe,
 *    which means it stops working exactly when it is under load.
 *  - A .ts module, not a .json/.txt data file, because tsc does not copy
 *    non-.ts files into dist/. Migrations and the email logo both needed
 *    explicit Dockerfile copy steps for that reason; a module compiles like any
 *    other source and cannot go missing in the container.
 *
 * This is a curated list of high-volume providers, not an exhaustive one — such
 * a list does not exist and chasing it is not worth a build step. It raises the
 * cost of automated signup enough to matter alongside the per-phone SMS cap,
 * which is the control that actually protects a victim.
 *
 * Matching is on the registrable parent too, so mail.mailinator.com is caught
 * by the mailinator.com entry (many of these hand out unlimited subdomains).
 */
const DISPOSABLE_DOMAINS: readonly string[] = [
  "0-mail.com",
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "33mail.com",
  "aikq.de",
  "anonbox.net",
  "anonymbox.com",
  "armyspy.com",
  "byom.de",
  "cool.fr.nf",
  "correo.blogos.net",
  "cuvox.de",
  "dayrep.com",
  "discard.email",
  "discardmail.com",
  "disposable.com",
  "disposableinbox.com",
  "dispostable.com",
  "dodgeit.com",
  "dodgit.com",
  "dontreg.com",
  "dropmail.me",
  "e4ward.com",
  "einrot.com",
  "emailfake.com",
  "emailondeck.com",
  "emailsensei.com",
  "emailtemporanea.net",
  "emailtemporario.com.br",
  "emltmp.com",
  "fakeinbox.com",
  "fakemail.net",
  "fakemailgenerator.com",
  "fleckens.hu",
  "gerolsteiner.de",
  "getairmail.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "harakirimail.com",
  "hidemail.de",
  "inbox.si",
  "inboxalias.com",
  "inboxbear.com",
  "inboxkitten.com",
  "incognitomail.com",
  "jetable.org",
  "linshiyouxiang.net",
  "luxusmail.org",
  "mail-temporaire.fr",
  "mail.tm",
  "mail7.io",
  "mailcatch.com",
  "maildrop.cc",
  "maildu.de",
  "mailexpire.com",
  "mailforspam.com",
  "mailinater.com",
  "mailinator.com",
  "mailinator.net",
  "mailinator.org",
  "mailmetrash.com",
  "mailnesia.com",
  "mailnull.com",
  "mailsac.com",
  "mailtemp.info",
  "mailtothis.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "msgden.com",
  "mt2015.com",
  "mytemp.email",
  "mytrashmail.com",
  "nada.email",
  "nowmymail.com",
  "objectmail.com",
  "onetimemail.org",
  "opayq.com",
  "pokemail.net",
  "rhyta.com",
  "rppkn.com",
  "safetymail.info",
  "sharklasers.com",
  "shitmail.me",
  "slopsbox.com",
  "spam4.me",
  "spamavert.com",
  "spambog.com",
  "spambox.us",
  "spamdecoy.net",
  "spamex.com",
  "spamfree24.org",
  "spamgourmet.com",
  "spamherelots.com",
  "spamhole.com",
  "spaml.com",
  "spamspot.com",
  "superrito.com",
  "teleworm.us",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempemail.net",
  "tempinbox.com",
  "tempm.com",
  "tempmail.net",
  "tempmail.plus",
  "tempmailaddress.com",
  "tempmailer.com",
  "tempomail.fr",
  "temporaryemail.net",
  "temporaryforwarding.com",
  "temporaryinbox.com",
  "tempr.email",
  "thankyou2010.com",
  "throwawaymail.com",
  "tmail.ws",
  "tmailinator.com",
  "trash-mail.at",
  "trash-mail.com",
  "trash2009.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.me",
  "trashmail.net",
  "trashmail.org",
  "trbvm.com",
  "trillianpro.com",
  "vomoto.com",
  "wegwerfmail.de",
  "wegwerfmail.net",
  "wegwerfmail.org",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "zetmail.com",
];

const DENIED = new Set(DISPOSABLE_DOMAINS);

/** Exposed for tests and for anyone auditing the list's size. */
export function disposableDomainCount(): number {
  return DENIED.size;
}

/**
 * Is this email address on a known disposable provider?
 *
 * Checks the full domain and every registrable parent of it, so a provider that
 * hands out `anything.mailinator.com` is covered by the one base entry. The
 * walk stops before the bare TLD, so a single-label suffix can never match.
 */
export function isDisposableEmailDomain(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;

  const labels = domain.split(".");
  // i stops at labels.length - 2 so the candidate always has at least two
  // labels: suffixes like "com" are never tested and so can never be denied.
  for (let i = 0; i <= labels.length - 2; i++) {
    if (DENIED.has(labels.slice(i).join("."))) return true;
  }
  return false;
}
