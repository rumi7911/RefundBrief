// Fictional sample cases (synthetic, November 2026). All names, bookings and
// payments are invented for demonstration. Captures are synthetic sandbox-style
// identifiers and are NEVER sent to PayPal in sample mode. Two cases ship with a
// clearly-labelled STORED EXAMPLE brief (not live AI output); one is deliberately
// incomplete so the owner must add evidence before a brief is possible.

import type { DB } from "./db.ts";
import type { RawBrief } from "./domain/brief.ts";

interface SeedSource {
  id: string;
  title: string;
  kind: string;
  text: string;
}
interface SeedCase {
  id: string;
  title: string;
  customer: string | null;
  captureId: string;
  paidPennies: number;
  paidAt: string;
  sources: SeedSource[];
  exampleBrief?: RawBrief;
}

const MERCHANT = "SAMPLE-MERCHANT-GBP";

export const SAMPLE_CASES: SeedCase[] = [
  {
    id: "sample-deep-clean",
    title: "A cancelled deep clean",
    customer: "Taylor Green",
    captureId: "SAMPLE-CAP-DEEPCLEAN-2026",
    paidPennies: 18000,
    paidAt: "12 Nov 2026",
    sources: [
      {
        id: "deepclean-policy",
        title: "Terms and cancellation policy",
        kind: "policy",
        text: "Cancellation policy (excerpt)\nCancellations made at least 24 hours before the scheduled visit are eligible for a full refund. Cancellations made less than 24 hours before the visit may be eligible for a partial refund at our discretion, as we may have reserved staff time.",
      },
      {
        id: "deepclean-work",
        title: "Booking details and job status",
        kind: "work",
        text: "Booking reference: BR-44821\nService: Deep clean (4 hours)\nScheduled for: Fri 13 Nov 2026, 09:00\nStatus: Cancelled — no visit made\nNotes: Customer cancelled the booking.",
      },
      {
        id: "deepclean-message",
        title: "Email from customer",
        kind: "message",
        text: "From: taylor.green@example.com\nTo: bookings@yourbusiness.co.uk\nSubject: Need to cancel this week's clean\nDate: 12 Nov 2026 (receipt time not recorded)\n\nHi,\nI need to cancel Friday's deep clean. Something unexpected has come up and I won't be home. Please confirm I'll receive a refund.\nThanks,\nTaylor",
      },
    ],
    exampleBrief: {
      summary:
        "Taylor Green booked a deep clean, cancelled before the scheduled visit, and asked to be refunded. Whether a full refund applies depends on exactly when the cancellation was received.",
      timeline: [
        {
          title: "Deep clean booked",
          detail: "A four-hour deep clean was booked and later referenced by the booking record.",
          occurredAt: "12 Nov 2026",
          citations: [{ sourceId: "deepclean-work", quote: "Service: Deep clean (4 hours)" }],
        },
        {
          title: "Visit cancelled",
          detail: "The booking record shows the visit was cancelled and no visit was made.",
          occurredAt: "13 Nov 2026",
          citations: [{ sourceId: "deepclean-work", quote: "Status: Cancelled — no visit made" }],
        },
        {
          title: "Refund requested",
          detail: "The customer emailed asking to confirm a refund.",
          occurredAt: "12 Nov 2026",
          citations: [{ sourceId: "deepclean-message", quote: "Please confirm I'll receive a refund." }],
        },
      ],
      uncertainties: [
        "The work record does not state the exact time the cancellation was received, only the date.",
      ],
      questions: [
        "Was the cancellation received at least 24 hours before the scheduled visit?",
      ],
    },
  },
  {
    id: "sample-missed-appointment",
    title: "A missed appointment",
    customer: "Sam Rivers",
    captureId: "SAMPLE-CAP-MISSED-2026",
    paidPennies: 12000,
    paidAt: "18 Nov 2026",
    sources: [
      {
        id: "missed-message",
        title: "Email from customer",
        kind: "message",
        text: "From: sam.rivers@example.com\nSubject: Refund for missed slot\nDate: 18 Nov 2026, 19:40\n\nNobody showed up for my appointment today and I'd like my £120 back.",
      },
    ],
    // Intentionally no example brief: the policy and work record are missing, so
    // a grounded brief cannot be produced until the owner adds that evidence.
  },
  {
    id: "sample-completed-consultation",
    title: "A completed consultation",
    customer: "Morgan Ellis",
    captureId: "SAMPLE-CAP-CONSULT-2026",
    paidPennies: 4500,
    paidAt: "24 Nov 2026",
    sources: [
      {
        id: "consult-policy",
        title: "Consultation fee policy",
        kind: "policy",
        text: "Consultation fees are non-refundable once the consultation has taken place. If a consultation is cancelled before it begins, the fee is refunded in full.",
      },
      {
        id: "consult-work",
        title: "Booking details and job status",
        kind: "work",
        text: "Booking reference: BR-45102\nService: Initial consultation (45 minutes)\nScheduled for: Mon 24 Nov 2026, 10:00\nStatus: Completed — consultation delivered\nNotes: Full session delivered; notes shared afterwards.",
      },
      {
        id: "consult-message",
        title: "Email from customer",
        kind: "message",
        text: "From: morgan.ellis@example.com\nSubject: Was hoping for a refund\nDate: 25 Nov 2026, 08:10\n\nHi, I had my consultation yesterday but I've decided not to continue. Would it be possible to get the £45 back?",
      },
    ],
    exampleBrief: {
      summary:
        "Morgan Ellis attended a completed consultation and afterwards asked for a refund because they decided not to continue.",
      timeline: [
        {
          title: "Consultation delivered",
          detail: "The booking record marks the consultation as completed and delivered.",
          occurredAt: "24 Nov 2026",
          citations: [{ sourceId: "consult-work", quote: "Status: Completed — consultation delivered" }],
        },
        {
          title: "Refund requested after the session",
          detail: "The customer wrote the next day asking for the fee back after deciding not to continue.",
          occurredAt: "25 Nov 2026",
          citations: [
            { sourceId: "consult-message", quote: "I had my consultation yesterday but I've decided not to continue." },
          ],
        },
      ],
      uncertainties: [
        "The policy text describes completed consultations as non-refundable; applying it is the owner's decision, not the assistant's.",
      ],
      questions: [],
    },
  },
];

export function seedIfEmpty(db: DB): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM cases").get() as { n: number };
  if (row.n > 0) return;
  const now = new Date().toISOString();
  for (const c of SAMPLE_CASES) {
    const briefVersion = c.exampleBrief ? 1 : 0;
    db.prepare(
      `INSERT INTO cases (id,title,is_sample,customer_name,capture_id,merchant_id,currency,paid_pennies,capture_amount_pennies,capture_status,paid_at,revision,brief_version,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(c.id, c.title, 1, c.customer, c.captureId, MERCHANT, "GBP", c.paidPennies, c.paidPennies, "COMPLETED", c.paidAt, 1, briefVersion, now);
    c.sources.forEach((s, i) => {
      db.prepare(
        `INSERT INTO sources (id,case_id,title,kind,text,sort_order,added_at) VALUES (?,?,?,?,?,?,?)`,
      ).run(s.id, c.id, s.title, s.kind, s.text, i, now);
    });
    if (c.exampleBrief) {
      db.prepare(
        `INSERT INTO briefs (id,case_id,version,case_revision,kind,payload,created_at) VALUES (?,?,?,?,?,?,?)`,
      ).run(`${c.id}-example-1`, c.id, 1, 1, "example", JSON.stringify(c.exampleBrief), now);
    }
  }
}

/** Example brief fixture for the "Load example brief" action, keyed by case id. */
export function exampleBriefFor(caseId: string): RawBrief | null {
  return SAMPLE_CASES.find((c) => c.id === caseId)?.exampleBrief ?? null;
}

export const SAMPLE_MERCHANT_ID = MERCHANT;
