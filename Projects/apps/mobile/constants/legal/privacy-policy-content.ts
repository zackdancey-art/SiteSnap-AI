/**
 * Privacy Policy — rendered by Projects/apps/mobile/app/privacy-policy.tsx.
 *
 * DO NOT edit this text here alone. The canonical source is docs/legal/privacy-policy.md, and
 * Projects/scripts/ci.sh fails the build when this file's words diverge from it or
 * from the website copy. Edit the canonical file and every render target in one
 * commit. docs/legal/README.md explains the check and records that this document
 * has NOT been reviewed by a lawyer.
 *
 * The text between the BEGIN/END markers below is what the check compares.
 */

export type LegalSection = {
  title: string;
  paragraphs: string[];
};

export type LegalDocument = {
  title: string;
  lastUpdated: string;
  intro: string[];
  sections: LegalSection[];
};

// BEGIN LEGAL TEXT
export const PRIVACY_POLICY: LegalDocument = {
  title: "Privacy Policy",
  lastUpdated: "Last updated: 3 October 2026",
  intro: [
    "SiteSnap AI Limited, NZBN 9429053872258, is a New Zealand company. This policy "
      + "explains what the SiteSnap app and supervisor portal collect, where it goes, who can "
      + "see it, and what you can ask us to do about it. It is written to be read, not to be "
      + "impressive. Where the product does not yet do something, this policy says so rather "
      + "than implying it does.",
  ],
  sections: [
    {
      title: "1. Who we are",
      paragraphs: [
        "SiteSnap AI Limited, NZBN 9429053872258, Christchurch, New Zealand. We operate the "
          + "SiteSnap mobile app and the supervisor web portal.",
        "For anything to do with privacy, email support@getsitesnapai.com with Privacy in "
          + "the subject line. That address reaches a person, not a team.",
      ],
    },
    {
      title: "2. Three kinds of people appear in SiteSnap",
      paragraphs: [
        "Read the part that applies to you.",
        "If you hold an account, you signed up, you agreed to the Terms, and you control "
          + "what you put in. Most of this policy is about you.",
        "If you were invited to a site, someone with an account sent an invitation to your "
          + "email address. You have an account of your own once you accept it, and you are "
          + "then in the first group.",
        "If your name was typed into a timesheet, you may have no account and no "
          + "invitation. Someone you work for entered your name as free text on a timecard, and "
          + "the app now holds your name against dates, start and finish times, breaks and "
          + "hours. We have no way to contact you, no record of your email address, and no way "
          + "to confirm who you are if you write to us. We cannot give you a login, and we "
          + "cannot look your records up for you on request, because we cannot verify that you "
          + "are the person named. The only route is through the business that entered you. We "
          + "would rather state that plainly than imply a door exists.",
      ],
    },
    {
      title: "3. What we collect",
      paragraphs: [
        "Your account. Name, email address, phone number, and a password stored as a scrypt "
          + "hash rather than as the password itself. While you are signing up we also hold the "
          + "email and SMS verification codes until the signup completes or expires.",
        "Your sites and records. Site names and addresses, diary entries, free-text notes "
          + "including hourly notes, weather, crew counts, photographs and their captions, "
          + "incident reports including the name of an injured person and witness notes, "
          + "inspections and their findings, material deliveries, and timesheets.",
        "Timesheets. A worker name as free text, the date, start and finish times, break "
          + "minutes, regular and overtime hours, trade and notes. This is employment data. In "
          + "a wage dispute it is evidence.",
        "Signatures. Where an inspection is signed, we store the signature as the path data "
          + "of the strokes you drew, plus the signer name and role, the time, and a hash of "
          + "the signed content. Neither New Zealand nor Australian privacy law treats a "
          + "handwritten signature as a special category of information, and we are not "
          + "claiming it is one. We treat it carefully anyway, because it is an identity "
          + "attestation and it is attached to safety records about a named person.",
        "Photographs. The image, your caption, who uploaded it, which company it belongs "
          + "to, and the time. When you take a photograph, the app reads the location recorded "
          + "by your camera out of the image's own metadata and stores those coordinates as "
          + "part of the entry. So a photograph can place a named crew at a place and a time.",
        "What we have not verified about photographs. The app re-encodes every image before "
          + "upload, at reduced quality, which would not normally carry the original camera "
          + "metadata through. We have not inspected an uploaded file to confirm that, so we "
          + "are not going to tell you the metadata is stripped. Treat it as unverified. The "
          + "coordinates described above are read deliberately and are stored regardless.",
        "Your device. Device type, operating system version, and a push notification token, "
          + "which is a durable identifier for that specific device.",
        "Location tracking. The app contains the code for periodic location tracking of a "
          + "worker while the app is open, writing coordinates every five minutes. There is no "
          + "screen anywhere in the app that turns it on, so it is off, it cannot be switched "
          + "on by you or by us through the app, and nothing is being collected by it today. We "
          + "are telling you it exists because it does, and because the honest version of this "
          + "policy is not the one that waits until the screen is built.",
        "What we do not collect. There is no analytics, no advertising, no tracking or "
          + "attribution software of any kind in the app, and the SiteSnap marketing website "
          + "loads no external scripts at all. Nobody is profiling you, and we have nothing to "
          + "sell to anyone who would want to.",
      ],
    },
    {
      title: "4. Where your information is stored, and in which country",
      paragraphs: [
        "The app, the database and the server logs run on Render in Singapore.",
        "Site photographs and files are stored in Amazon S3 in Sydney, Australia.",
        "An older photograph bucket exists in Amazon S3 in Northern Virginia, in the United "
          + "States, from earlier in the product's life. Nothing in SiteSnap ever deletes a "
          + "stored file, so older photographs are still in it.",
        "Your phone holds a copy of a good deal of this. Your login token, your profile "
          + "including your emergency contact, cached photographs as raw image data, drafts and "
          + "the offline queue are all held in the app's ordinary storage on the device. We do "
          + "not use the phone's secure keystore for any of it. On an iPhone the app's storage "
          + "is protected by the device passcode, which is real protection, but it is not the "
          + "same thing as keychain storage and we are not going to describe it as if it were.",
      ],
    },
    {
      title: "5. Sending information out of New Zealand",
      paragraphs: [
        "Principle 12 of the Privacy Act 2020 governs giving personal information to "
          + "someone overseas. Here is where our information actually goes and what we think "
          + "the position is for each.",
        "Singapore, for hosting. Render holds and runs the database, the app server and the "
          + "logs. It stores and processes our records for us and does not use them for its own "
          + "purposes. Where an overseas provider holds information purely as our agent, the "
          + "Act treats that information as still held by us, and sending it to them is not a "
          + "disclosure, so Principle 12 does not apply to it. We remain responsible for their "
          + "safeguards either way. If that reading is wrong and it is a disclosure, the "
          + "position is this: Singapore has a general data protection statute, the Personal "
          + "Data Protection Act 2012, with a regulator and mandatory breach reporting. But "
          + "that Act lifts most of its obligations off a provider acting as a data "
          + "intermediary for someone else, leaving only its security and retention duties, so "
          + "leaning on Singapore's law alone is weaker than it sounds. The safer basis is a "
          + "contract, and we have Render's standard terms and no separate data processing "
          + "agreement. No country has been formally prescribed as having comparable safeguards "
          + "under the Act, so that route is not available to us or to anyone else.",
        "Australia, for photographs. Amazon S3 in Sydney holds and stores files for us, in "
          + "the same agent position as Render. Australia's Privacy Act 1988 is the closest "
          + "comparable regime to New Zealand's of any country our information reaches.",
        "The United States, for three things. Photographs and notes go to OpenAI when you "
          + "generate an AI diary, described in section 6. Email addresses and invitation links "
          + "go to Resend to send email. Phone numbers and verification codes go to Twilio to "
          + "send SMS. Crash reports from the server go to Sentry. The older photograph bucket "
          + "named in section 4 is also in the United States.",
        "OpenAI is a genuine disclosure rather than an agent arrangement, because OpenAI "
          + "retains what we send it for its own abuse-monitoring purposes. The basis for that "
          + "disclosure is OpenAI's standard API terms. We hold no data processing agreement "
          + "with OpenAI, Resend, Twilio, Amazon or Render — only each one's ordinary published "
          + "terms. We would rather you knew that than read a sentence claiming all overseas "
          + "transfers comply with Principle 12.",
      ],
    },
    {
      title: "6. The AI diary feature, specifically",
      paragraphs: [
        "When you ask SiteSnap to generate a diary, the app sends OpenAI the whole site "
          + "record, which includes the site name and address, and for each entry the date, the "
          + "site address, the weather, the crew count, your notes, and your photo captions. It "
          + "also sends up to twelve of the photographs themselves, each with the entry date, "
          + "the site location, the time the photo was taken and your caption.",
        "Nothing is removed or masked before it is sent. If a note names a person, that "
          + "name goes. If a photograph shows a face, that face goes.",
        "We tell OpenAI not to store the request. That is a real setting and we pass it on "
          + "every call, and it shortens what OpenAI keeps. OpenAI separately keeps "
          + "abuse-monitoring logs for up to thirty days, which we cannot turn off. OpenAI does "
          + "not train on data sent through its API.",
        "The generated text is a draft. A person has to read it before it becomes a site record.",
      ],
    },
    {
      title: "7. How we use your information",
      paragraphs: [
        "To run the service: showing you your sites, storing your entries, generating "
          + "diaries and producing reports.",
        "To verify who you are and let you back in: verification codes and password resets.",
        "To keep site records: diary and safety records are the product. Keeping them is "
          + "the point of it.",
        "We do not use your information to build a profile of you, we do not sell it, and "
          + "we do not use your records to train anything.",
      ],
    },
    {
      title: "8. How long we keep things, and what deleting really does",
      paragraphs: [
        "This is the section most likely to differ from what you expect, so it is written "
          + "out in full.",
        "Deleting a record. Incidents, timesheets, inspections and deliveries are marked "
          + "deleted and disappear from the app immediately. The row stays in the database. "
          + "That is deliberate: these are compliance records and a construction business is "
          + "generally expected to be able to produce them for years after the fact.",
        "Deleting your account. This genuinely deletes a great deal. Your user record goes, "
          + "and with it your sites, entries, diaries, templates, push tokens, timesheets, "
          + "incidents, inspections and their signatures, deliveries, password reset tokens, "
          + "site invitations and memberships, and any stored locations.",
        "What survives deleting your account, honestly. The record of the uploads you made "
          + "survives, because it is not linked to your account in a way that would remove it. "
          + "Every photograph file itself survives: nothing in SiteSnap deletes a stored file, "
          + "not when you delete a record, not when you delete your account, and not on any "
          + "schedule. Your company's record survives, by design, under the retention model "
          + "above. If you ask us to delete your account expecting your photographs to be gone "
          + "from our storage, they will not be, and we would rather say so here than let you "
          + "find out later.",
        "Seven years, and the thing it conflicts with. Construction and health-and-safety "
          + "record keeping means site records need to outlive an account. That is why deletion "
          + "is a flag and why the company record stays. It cannot be reconciled with a promise "
          + "that deleting your account deletes your photographs, and we are not going to print "
          + "both.",
        "No automatic purge exists. There is no scheduled job in SiteSnap that deletes "
          + "anything when a retention period ends. If a retention period expires, nothing "
          + "happens on its own.",
      ],
    },
    {
      title: "9. Asking for a copy of your information, or a correction",
      paragraphs: [
        "Under Principle 6 of the Privacy Act 2020 you can ask for the personal information "
          + "we hold about you. Under Principle 7 you can ask us to correct it.",
        "Email support@getsitesnapai.com with Privacy Request in the subject line and we "
          + "will do it by hand. We will respond within twenty working days, which is what the "
          + "Act requires.",
        "There is no self-service export that does this job. The Back up data button in the "
          + "app saves a copy of the sites, entries and diaries that are cached on your phone. "
          + "It is useful, and it is not an access request: it leaves out timesheets, "
          + "incidents, inspections, signatures, locations, photographs and your account "
          + "record, and it reads from your device rather than from our database. We are not "
          + "going to call it a data export when it is not one.",
      ],
    },
    {
      title: "10. What we have not built yet",
      paragraphs: [
        "We would rather list these than let the rest of the policy imply otherwise.",
        "One person can see everything, and nothing records that they looked. The founder "
          + "holds the hosting, database and storage credentials. There is no separation "
          + "between running the service and reading what is in it, and no log of who read "
          + "what.",
        "There is no breach detection. The Privacy Act 2020 requires us to notify the "
          + "Privacy Commissioner and the people affected about a notifiable privacy breach. We "
          + "would do that. But we have no monitoring that would reliably tell us a breach had "
          + "happened, and no written process for handling one. Crash reporting from the app "
          + "itself is not switched on.",
        "Device storage is not encrypted by us. See section 4.",
        "We have no data processing agreement with any of our providers. See section 5.",
        "We have not verified what camera metadata survives upload. See section 3.",
      ],
    },
    {
      title: "11. Security, as it actually stands",
      paragraphs: [
        "Passwords are stored as scrypt hashes, never as passwords. Traffic to the server "
          + "uses HTTPS, with HSTS in production. Each company's data is separated inside the "
          + "database itself by row-level security, so a query cannot cross from one company to "
          + "another even if the application asks it to — that is enforced by the database and "
          + "not only by the app.",
        "We are not claiming any certification. We have no SOC 2 report, no ISO "
          + "certification, and we are not going to describe our security as bank-grade or "
          + "military-grade. Section 10 is the honest other half of this section and should be "
          + "read with it.",
      ],
    },
    {
      title: "12. Children",
      paragraphs: [
        "SiteSnap is for people working in construction and is intended for adults. We do "
          + "not knowingly collect information about children. Be aware that if you type a "
          + "young worker's name into a timesheet, we hold it, and we had no way to know.",
      ],
    },
    {
      title: "13. Changes to this policy",
      paragraphs: [
        "If we change something that matters, we will tell you in the app or by email at "
          + "least fourteen days before it takes effect. The date at the top changes whenever "
          + "the text does.",
      ],
    },
    {
      title: "14. Complaints",
      paragraphs: [
        "Email support@getsitesnapai.com first, and we will try to sort it out.",
        "If you are not satisfied, you can complain to the Office of the Privacy "
          + "Commissioner in New Zealand at privacy.org.nz. If you are in Australia, you can "
          + "also contact the Office of the Australian Information Commissioner at oaic.gov.au.",
      ],
    },
  ],
};
// END LEGAL TEXT
