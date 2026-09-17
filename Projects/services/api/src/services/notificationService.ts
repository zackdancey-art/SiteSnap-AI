import { buildEmailHtml } from "./emailTemplates";

type DeliveryChannel = "email" | "sms";

type PasswordResetPayload = {
  channel: DeliveryChannel;
  email?: string;
  phone?: string;
  resetLink: string;
};

type VerificationPayload = {
  channel: DeliveryChannel;
  email?: string;
  phone?: string;
  code: string;
};

type DeliveryResult = {
  ok: boolean;
  provider?: string;
  error?: string;
};

function isConfigured(value?: string) {
  return Boolean(value && value.trim());
}

function isTestMode() {
  return process.env.NODE_ENV === "test";
}

type FakeSend =
  | { kind: "email"; to: string; subject: string; text: string; html: string; at: number }
  | { kind: "sms"; to: string; body: string; at: number };

// Belt-and-braces record of what test mode "would have sent" — never used to
// dispatch anything, just available for tests that want to assert on it.
const fakeSends: FakeSend[] = [];

export function getFakeSendsForTests(): readonly FakeSend[] {
  return fakeSends;
}

export function resetFakeSendsForTests(): void {
  fakeSends.length = 0;
}

async function sendWithResend(
  to: string,
  subject: string,
  text: string,
  html: string
): Promise<DeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!isConfigured(apiKey) || !isConfigured(from)) {
    return { ok: false, error: "Resend is not configured." };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      html,
      ...(process.env.EMAIL_REPLY_TO ? { reply_to: process.env.EMAIL_REPLY_TO } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, provider: "resend", error: `Resend failed (${res.status}): ${body}` };
  }

  return { ok: true, provider: "resend" };
}

async function sendWithSendGrid(
  to: string,
  subject: string,
  text: string,
  html: string
): Promise<DeliveryResult> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!isConfigured(apiKey) || !isConfigured(from)) {
    return { ok: false, error: "SendGrid is not configured." };
  }

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
      ...(process.env.EMAIL_REPLY_TO
        ? { reply_to_list: [{ email: process.env.EMAIL_REPLY_TO }] }
        : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, provider: "sendgrid", error: `SendGrid failed (${res.status}): ${body}` };
  }

  return { ok: true, provider: "sendgrid" };
}

function getEmailProvider() {
  if (isConfigured(process.env.RESEND_API_KEY) && isConfigured(process.env.EMAIL_FROM)) {
    return "resend" as const;
  }
  if (isConfigured(process.env.SENDGRID_API_KEY) && isConfigured(process.env.EMAIL_FROM)) {
    return "sendgrid" as const;
  }
  return null;
}

async function sendEmail(to: string, subject: string, text: string, html: string): Promise<DeliveryResult> {
  // Structural guard: in test mode, never make a real network call — even if
  // real provider keys are present in the environment (e.g. a contaminated
  // .env). No branch below this point is reachable in test mode.
  //
  // Deliberately `ok: false`, not `ok: true`: routes/auth.ts's registration
  // and password-reset flows only surface `devCodes`/reset-link fallbacks
  // when a delivery is unconfigured or fails, and the existing test suite's
  // `registerAndLogin`/`createWorkerToken` helpers rely on that fallback to
  // read verification codes without a real inbox. Returning success here
  // (with real provider keys present in this repo's `.env`) would make the
  // route believe delivery succeeded and stop returning devCodes, breaking
  // that path outright — verified experimentally (32/44 tests fail with
  // `ok: true`, 0 fail with `ok: false`). Both values are equally "no real
  // network call" for the safety property this guard exists for.
  if (isTestMode()) {
    fakeSends.push({ kind: "email", to, subject, text, html, at: Date.now() });
    return { ok: false, provider: "test-fake", error: "Test mode: email send faked, not dispatched." };
  }

  const provider = getEmailProvider();
  if (provider === "resend") return sendWithResend(to, subject, text, html);
  if (provider === "sendgrid") return sendWithSendGrid(to, subject, text, html);
  return {
    ok: false,
    error:
      "No email provider configured. Set RESEND_API_KEY + EMAIL_FROM or SENDGRID_API_KEY + EMAIL_FROM.",
  };
}

function getSmsConfigured() {
  return (
    isConfigured(process.env.TWILIO_ACCOUNT_SID) &&
    isConfigured(process.env.TWILIO_AUTH_TOKEN) &&
    isConfigured(process.env.TWILIO_FROM_NUMBER)
  );
}

async function sendSms(to: string, bodyText: string): Promise<DeliveryResult> {
  // Structural guard: in test mode, never make a real network call — even if
  // real provider keys are present in the environment (e.g. a contaminated
  // .env). No branch below this point is reachable in test mode.
  // See the matching comment in sendEmail() for why this is `ok: false`.
  if (isTestMode()) {
    fakeSends.push({ kind: "sms", to, body: bodyText, at: Date.now() });
    return { ok: false, provider: "test-fake", error: "Test mode: SMS send faked, not dispatched." };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!getSmsConfigured() || !sid || !token || !from) {
    return {
      ok: false,
      error:
        "SMS provider not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.",
    };
  }

  const body = new URLSearchParams({ To: to, From: from, Body: bodyText });
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const responseBody = await res.text();
    return { ok: false, provider: "twilio", error: `Twilio failed (${res.status}): ${responseBody}` };
  }

  return { ok: true, provider: "twilio" };
}

export function isChannelConfigured(channel: DeliveryChannel): { ok: boolean; reason?: string } {
  // Structural guard, third of three — sendEmail() and sendSms() already have
  // the matching pair. In test mode a channel is ALWAYS configured, because the
  // transport that serves it is the in-process fake above, which needs no
  // credentials and makes no network call.
  //
  // Without this branch the predicate reads live RESEND_*/TWILIO_* while the
  // transports ignore them, so callers that gate on it (routes/auth.ts's
  // registration flow) take a DIFFERENT code path depending on whether a
  // developer's .env happens to hold real provider keys: locally the send runs
  // and records into fakeSends, in CI it is skipped entirely. That made every
  // "no SMS was sent" assertion pass vacuously in CI — true there no matter
  // what the code under test does. The channel check is about configuration,
  // and in test mode configuration is satisfied by the fake.
  if (isTestMode()) {
    return { ok: true };
  }

  if (channel === "email") {
    const provider = getEmailProvider();
    return provider
      ? { ok: true }
      : {
          ok: false,
          reason:
            "Email not configured. Set RESEND_API_KEY + EMAIL_FROM or SENDGRID_API_KEY + EMAIL_FROM.",
        };
  }

  if (!getSmsConfigured()) {
    return {
      ok: false,
      reason: "SMS not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.",
    };
  }
  return { ok: true };
}

export async function sendPasswordReset(payload: PasswordResetPayload): Promise<DeliveryResult> {
  if (payload.channel === "email") {
    if (!payload.email) return { ok: false, error: "Missing recipient email." };

    const subject = "Reset your SiteSnap password";
    const text =
      `We received a password reset request for your SiteSnap account.\n\n` +
      `Reset your password here:\n${payload.resetLink}\n\n` +
      `This link expires in 30 minutes. If you didn't request a reset, you can safely ignore this email.`;

    const html = buildEmailHtml({
      heading: "Reset your password",
      bodyLines: [
        "We received a request to reset your SiteSnap password.",
        "Click the button below to choose a new password. This link is valid for <strong>30 minutes</strong> and can only be used once.",
      ],
      ctaButton: { text: "Reset My Password", url: payload.resetLink },
      noteLines: [
        "If you didn't request this, no action is needed — your password won't change.",
      ],
    });

    return sendEmail(payload.email, subject, text, html);
  }

  if (!payload.phone) return { ok: false, error: "Missing recipient phone." };
  return sendSms(
    payload.phone,
    `SiteSnap: Reset your password here:\n${payload.resetLink}\n\nExpires in 30 min. If you didn't request this, ignore this message.`
  );
}

type SiteInvitePayload = {
  to: string;
  inviterName: string;
  siteName: string;
  role: string;
  token: string;
};

export async function sendSiteInvite(payload: SiteInvitePayload): Promise<DeliveryResult> {
  const inviteUrl = `${process.env.INVITE_URL || "sitesnap://invite"}?token=${payload.token}`;
  const subject = `You've been invited to join ${payload.siteName} on SiteSnap`;

  const text =
    `Hi,\n\n` +
    `${payload.inviterName} has invited you to collaborate on ${payload.siteName} as a ${payload.role}.\n\n` +
    `Accept your invitation here:\n${inviteUrl}\n\n` +
    `This invitation expires in 7 days.`;

  const html = buildEmailHtml({
    heading: "You've been invited to SiteSnap",
    bodyLines: [
      `<strong>${payload.inviterName}</strong> has invited you to collaborate on <strong>${payload.siteName}</strong> as a ${payload.role}.`,
      "Tap the button below to accept and get started.",
    ],
    ctaButton: { text: "Accept Invitation", url: inviteUrl },
    noteLines: ["This invitation expires in 7 days."],
  });

  const result = await sendEmail(payload.to, subject, text, html);
  if (!result.ok) {
    console.warn(`[invite] Email delivery failed for ${payload.to}: ${result.error}`);
  }
  return result;
}

export async function sendAccountVerification(payload: VerificationPayload): Promise<DeliveryResult> {
  if (payload.channel === "email") {
    if (!payload.email) return { ok: false, error: "Missing recipient email." };

    const subject = "Verify your SiteSnap account";
    const text =
      `Use this verification code to complete your SiteSnap signup: ${payload.code}\n\n` +
      `This code expires in 10 minutes. If you didn't create this account, you can ignore this message.`;

    const html = buildEmailHtml({
      heading: "Verify your account",
      bodyLines: [
        "Welcome to SiteSnap! Enter the code below to complete your account setup.",
      ],
      codeBlock: payload.code,
      noteLines: [
        "This code expires in <strong>10 minutes</strong>.",
        "If you didn't create this account, you can safely ignore this email.",
      ],
    });

    return sendEmail(payload.email, subject, text, html);
  }

  if (!payload.phone) return { ok: false, error: "Missing recipient phone." };
  return sendSms(payload.phone, `Your SiteSnap verification code is: ${payload.code}. Expires in 10 minutes.`);
}
