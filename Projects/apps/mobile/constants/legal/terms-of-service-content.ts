/**
 * Terms of Service — rendered by Projects/apps/mobile/app/terms-of-service.tsx.
 *
 * DO NOT edit this text here alone. The canonical source is docs/legal/terms-of-service.md, and
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
export const TERMS_OF_SERVICE: LegalDocument = {
  title: "Terms of Service",
  lastUpdated: "Last updated: 3 October 2026",
  intro: [
    "These are the terms you agree to by using SiteSnap. They are a binding agreement "
      + "between you and SiteSnap AI Limited, NZBN 9429053872258, a New Zealand company.",
  ],
  sections: [
    {
      title: "1. What you are agreeing to",
      paragraphs: [
        "By creating an account or using the SiteSnap app or the supervisor portal, you "
          + "agree to these terms and to our Privacy Policy. If you do not agree, do not use "
          + "it.",
        "SiteSnap is currently in testing and is distributed through Apple TestFlight. It "
          + "has not been submitted to the App Store for review. Expect the rough edges of "
          + "software that is still being built, and read section 9 before you rely on it for "
          + "anything that matters.",
      ],
    },
    {
      title: "2. What SiteSnap does",
      paragraphs: [
        "SiteSnap is a site records app. You capture daily diaries, photographs, incidents, "
          + "inspections, deliveries and timesheets from the field, and it produces PDF and "
          + "Word reports from them. It can draft a diary narrative for you using AI, which "
          + "section 6 covers.",
      ],
    },
    {
      title: "3. Your account",
      paragraphs: [
        "You need a working email address and mobile number to sign up. Keep your login to "
          + "yourself, give us accurate details, and tell us at support@getsitesnapai.com "
          + "straight away if you think someone else has got into your account. What happens "
          + "under your login is your responsibility.",
        "Note that your login token is stored in ordinary storage on your phone rather than "
          + "in the phone's secure keystore. If someone can unlock your phone, they can use "
          + "your account. Our Privacy Policy says the same thing in more detail.",
      ],
    },
    {
      title: "4. Acceptable use",
      paragraphs: [
        "Use SiteSnap for lawful site management. Do not do any of the following.",
        "Upload anything illegal, defamatory, or that you do not have the right to upload.",
        "Put other people's personal information in without a proper basis for holding it. "
          + "This one is not boilerplate: typing a worker's name and hours into a timesheet "
          + "creates an employment record about a real person who may never have heard of us. "
          + "You are the one who has to be entitled to hold it.",
        "Try to get into parts of the service that are not yours, or into our infrastructure.",
        "Pull the app apart to extract its source code, or use scripts to scrape or "
          + "bulk-download.",
        "Interfere with the service working for other people.",
      ],
    },
    {
      title: "5. Your content is yours",
      paragraphs: [
        "You own everything you put into SiteSnap. Photographs, notes, diaries, reports, "
          + "timesheets, all of it. Uploading it does not give us ownership of it and does not "
          + "give us a share in it.",
        "What you give us is permission to do the things the service obviously has to do "
          + "with it: store it, show it back to you and to the people in your company, process "
          + "it to generate your reports, and send it to the providers listed in our Privacy "
          + "Policy so those features work. That permission exists only to run the service for "
          + "you. It ends when you delete the content or your account, subject to what our "
          + "Privacy Policy says actually survives deletion — read that, because it is more "
          + "honest than most.",
        "We will not sell your content. We will not use your content to train AI models, "
          + "and the AI provider we use does not train on it either. We will not use your "
          + "photographs or your site records to market SiteSnap unless you tell us in writing "
          + "that we can.",
      ],
    },
    {
      title: "6. The AI drafts, and what they are not",
      paragraphs: [
        "SiteSnap sends your notes, captions and photographs to OpenAI to draft diary text "
          + "and safety observations. Our Privacy Policy sets out exactly what gets sent.",
        "What comes back is a draft. It can be wrong, it can miss things, and it can "
          + "describe something that is not in the photograph. It is not advice, it is not a "
          + "professional opinion, and it has no standing of its own. A qualified person has to "
          + "read it before it becomes a record you rely on.",
        "You are responsible for what goes out under your name, whether or not AI drafted it.",
      ],
    },
    {
      title: "7. Health and safety",
      paragraphs: [
        "SiteSnap is a record-keeping tool. It is not health-and-safety advice and it is "
          + "not a safety management system.",
        "Making your records comply with the Health and Safety at Work Act 2015, or with "
          + "the work health-and-safety law of the Australian state you are in, is your job and "
          + "your business's job. An AI-drafted safety observation is not a professional "
          + "assessment. We accept no liability for an incident, a breach, a fine or an "
          + "enforcement action arising from how you used the service.",
      ],
    },
    {
      title: "8. Paying for it",
      paragraphs: [
        "SiteSnap is free to use today. There is no paid tier, no checkout and no payment "
          + "mechanism in the product at all.",
        "If we introduce paid plans, we will tell you before anything starts costing money, "
          + "and you will have to actively agree to a plan rather than being moved onto one. "
          + "Prices will be in New Zealand dollars.",
        "What happens if you stop paying, once there is something to pay. We will not "
          + "delete your records because a subscription lapsed. If your plan ends or you stop "
          + "paying, you keep read access to your existing records and the ability to export "
          + "them for at least ninety days, and we will not hold your own site diaries hostage "
          + "to get you to pay. New captures may stop. If we ever have to change that, section "
          + "12 applies and you will get notice.",
      ],
    },
    {
      title: "9. What we do not promise",
      paragraphs: [
        "SiteSnap is provided as it is. We do not warrant that it will be available, that "
          + "it will not lose data, or that it is fit for a particular purpose beyond what "
          + "these terms describe. It is in testing.",
        "Keep your own copies of anything you cannot afford to lose. The app can export "
          + "your records and you should use that.",
        "To the extent the law allows, we are not liable for indirect or consequential "
          + "loss, and our total liability to you for anything connected with the service is "
          + "limited to the amount you have paid us in the twelve months before the claim. "
          + "Today that amount is nothing, which is the plain consequence of section 8 and is "
          + "the main reason to read section 9 carefully.",
        "Nothing in these terms takes away rights you have under the Consumer Guarantees "
          + "Act 1993 or the Fair Trading Act 1986, or, if you are in Australia, under the "
          + "Australian Consumer Law. If you are using SiteSnap in trade, some of those "
          + "protections may be limited to the extent the law allows that.",
      ],
    },
    {
      title: "10. Ending it",
      paragraphs: [
        "You can delete your account in Settings whenever you like. Read the deletion "
          + "section of our Privacy Policy first, because what deletion does is specific and "
          + "some things survive it.",
        "We can suspend or close your account if you break these terms. If we do that other "
          + "than for a breach, we will give you a reasonable chance to get your records out "
          + "first.",
      ],
    },
    {
      title: "11. Our stuff",
      paragraphs: [
        "The app, the portal, the website and the SiteSnap name are ours. These terms do "
          + "not transfer any of that to you. Section 5 is about your content, and it is not "
          + "affected by this section.",
      ],
    },
    {
      title: "12. Changes to these terms",
      paragraphs: [
        "We will give you at least fourteen days' notice in the app or by email before a "
          + "material change takes effect. If you keep using SiteSnap after that, you have "
          + "accepted the change. If you do not want to, you can close your account and export "
          + "your records.",
      ],
    },
    {
      title: "13. Which law applies",
      paragraphs: [
        "New Zealand law governs these terms, and the New Zealand courts have jurisdiction. "
          + "If you are in Australia, the consumer and privacy protections you have under "
          + "Australian law still apply and this section does not exclude them.",
      ],
    },
    {
      title: "14. Contact",
      paragraphs: [
        "SiteSnap AI Limited, NZBN 9429053872258, Christchurch, New Zealand. "
          + "support@getsitesnapai.com.",
      ],
    },
  ],
};
// END LEGAL TEXT
