// Fixture data for the Option-A (local-distill) fidelity eval harness
// (`scripts/eval/option-a-fidelity.ts`). See
// `scripts/eval/README-option-a-fidelity.md` for what this harness measures
// and why.
//
// Each fixture pairs a realistic (synthetic) raw connector payload with a
// natural user question that actually needs data from that payload to
// answer well. The harness asks the chat model the question twice — once
// with `rawConnectorText` in context (the reference answer) and once with
// the output of `distillConnectorPayload` in context (the Option-A answer)
// — then has a judge model score how well the distilled answer preserved
// the reference answer's correctness/completeness.
//
// This file is READ-ONLY with respect to production code: the payloads
// below are hand-written synthetic data, not copied from any real user or
// connector schema. Keep it editable — add/remove cases here to adjust
// coverage without touching the harness logic.

import type { OptionAFidelityCapability } from "../option-a-fidelity-scoring";

export type OptionAFidelityFixture = {
	id: string;
	capability: OptionAFidelityCapability;
	question: string;
	rawConnectorText: string;
};

export const OPTION_A_FIDELITY_FIXTURES: OptionAFidelityFixture[] = [
	{
		id: "calendar-next-meeting-with-person",
		capability: "calendar",
		question: "When's my next meeting with Zsombor?",
		rawConnectorText: [
			"EVENT 2026-07-09 09:00-09:30 | Daily standup | attendees: self, Priya, Mateo | location: Zoom",
			"EVENT 2026-07-09 14:00-15:00 | 1:1 with Zsombor Kiss | attendees: self, Zsombor Kiss | location: Meeting room 4B | notes: discuss Q3 roadmap, bring updated budget sheet",
			"EVENT 2026-07-10 11:00-12:00 | Vendor call | attendees: self, external (Acme Corp) | location: Zoom",
			"EVENT 2026-07-14 15:30-16:00 | Zsombor + design sync | attendees: self, Zsombor Kiss, Nora Varga | location: Meeting room 2A",
		].join("\n"),
	},
	{
		id: "calendar-conflict-check",
		capability: "calendar",
		question: "Do I have anything booked on Friday afternoon this week?",
		rawConnectorText: [
			"EVENT 2026-07-06 10:00-10:30 | Sprint planning | attendees: self, team | location: Zoom",
			"EVENT 2026-07-10 13:00-13:45 | Dentist appointment | attendees: self | location: Dental Clinic, 12 Vaci Street",
			"EVENT 2026-07-10 16:00-17:00 | Investor update call | attendees: self, Board | location: Zoom",
			"EVENT 2026-07-11 09:00-09:15 | Weekly retro | attendees: self, team | location: Meeting room 1",
		].join("\n"),
	},
	{
		id: "email-invoice-arrival",
		capability: "email",
		question: "Did the invoice from Acme arrive yet?",
		rawConnectorText: [
			"HEADER From: billing@acme-supplies.example | Subject: Invoice #A-4471 for June services | Date: 2026-07-08T10:12:00Z | Has attachment: invoice-A-4471.pdf",
			"HEADER From: newsletter@random-shop.example | Subject: 20% off summer sale | Date: 2026-07-08T08:00:00Z | Has attachment: none",
			"HEADER From: priya@company.example | Subject: Re: budget review | Date: 2026-07-07T16:40:00Z | Has attachment: none",
			"BODY (A-4471): Please find attached invoice #A-4471 for June services, total $4,280.00, due 2026-07-22. Let us know if you have questions.",
		].join("\n"),
	},
	{
		id: "email-unread-urgent",
		capability: "email",
		question: "Is there anything urgent in my inbox from my manager?",
		rawConnectorText: [
			"HEADER From: manager@company.example | Subject: URGENT: need sign-off before 3pm | Date: 2026-07-09T11:05:00Z | Unread: true",
			"HEADER From: hr@company.example | Subject: Reminder: benefits enrollment closes Friday | Date: 2026-07-09T09:00:00Z | Unread: true",
			"HEADER From: manager@company.example | Subject: Nice work on the release | Date: 2026-07-08T17:20:00Z | Unread: false",
			"BODY (URGENT: need sign-off before 3pm): The vendor contract needs your sign-off before 3pm today or we lose the discounted rate. Reply or call me.",
		].join("\n"),
	},
	{
		id: "files-latest-report-version",
		capability: "files",
		question: "Which version of the Q2 report is the most recent one?",
		rawConnectorText: [
			"FILE Q2-report-draft.docx | modified: 2026-06-02T10:00:00Z | size: 1.2MB | folder: /Reports/2026",
			"FILE Q2-report-v2.docx | modified: 2026-06-18T14:30:00Z | size: 1.4MB | folder: /Reports/2026",
			"FILE Q2-report-FINAL.docx | modified: 2026-06-30T09:15:00Z | size: 1.5MB | folder: /Reports/2026",
			"FILE Q2-report-FINAL-reviewed.docx | modified: 2026-07-05T16:45:00Z | size: 1.5MB | folder: /Reports/2026/Reviewed",
		].join("\n"),
	},
	{
		id: "files-find-by-topic",
		capability: "files",
		question: "Do I have any files about the vendor contract renewal?",
		rawConnectorText: [
			"FILE vacation-photos-2025.zip | modified: 2025-08-10T12:00:00Z | size: 340MB | folder: /Personal",
			"FILE vendor-contract-renewal-notes.pdf | modified: 2026-07-03T11:20:00Z | size: 200KB | folder: /Contracts",
			"FILE vendor-contract-renewal-redline.docx | modified: 2026-07-07T09:00:00Z | size: 90KB | folder: /Contracts",
			"FILE weekly-standup-notes.md | modified: 2026-07-08T09:00:00Z | size: 4KB | folder: /Notes",
		].join("\n"),
	},
	{
		id: "photos-last-beach-trip",
		capability: "photos",
		question:
			"When did I last go to the beach, and how many photos are from that day?",
		rawConnectorText: [
			"PHOTO taken: 2025-08-14T15:22:00Z | location: Lake Balaton, Siofok | tags: beach, sunset, friends | album: Summer 2025",
			"PHOTO taken: 2025-08-14T15:45:00Z | location: Lake Balaton, Siofok | tags: beach, friends | album: Summer 2025",
			"PHOTO taken: 2025-08-14T18:10:00Z | location: Lake Balaton, Siofok | tags: beach, sunset | album: Summer 2025",
			"PHOTO taken: 2025-12-24T19:00:00Z | location: Budapest | tags: family, christmas | album: Winter 2025",
			"PHOTO taken: 2026-03-02T13:00:00Z | location: Budapest | tags: hiking | album: Spring hikes",
		].join("\n"),
	},
	{
		id: "photos-screenshot-with-text",
		capability: "photos",
		question:
			"I remember screenshotting a WiFi password from a hotel confirmation, do you still have it?",
		rawConnectorText: [
			"PHOTO taken: 2026-05-10T20:00:00Z | type: screenshot | ocr_text: 'Hotel Bellevue confirmation. Room 214. WiFi network: BellevueGuest, password: SunnyBay2026' | album: Screenshots",
			"PHOTO taken: 2026-05-11T08:00:00Z | type: photo | ocr_text: none | tags: breakfast | album: Trip May 2026",
			"PHOTO taken: 2026-05-12T09:30:00Z | type: screenshot | ocr_text: 'Flight change confirmed. New departure 14:20.' | album: Screenshots",
		].join("\n"),
	},
	{
		id: "contacts-phone-lookup",
		capability: "contacts",
		question: "What's Eszter's phone number?",
		rawConnectorText: [
			"CONTACT name: Eszter Nagy | phone: +36 30 123 4567 | email: eszter.nagy@company.example | company: Company Ltd | notes: product design lead",
			"CONTACT name: Eszter Toth | phone: +36 20 987 6543 | email: eszter.toth@otherco.example | company: Other Co | notes: met at conference 2025",
			"CONTACT name: Mateo Rossi | phone: +36 70 555 1212 | email: mateo@company.example | company: Company Ltd | notes: backend team",
		].join("\n"),
	},
	{
		id: "contacts-shared-connection",
		capability: "contacts",
		question: "Who do I know at Acme Supplies?",
		rawConnectorText: [
			"CONTACT name: Janos Kovacs | phone: +36 30 111 2222 | email: janos.kovacs@acme-supplies.example | company: Acme Supplies | notes: account manager, handles our billing",
			"CONTACT name: Lena Fischer | phone: +49 151 000 0000 | email: lena@partnerco.example | company: Partner Co | notes: met at trade show",
			"CONTACT name: Priya Sharma | phone: +36 30 444 5555 | email: priya@company.example | company: Company Ltd | notes: internal, finance team",
		].join("\n"),
	},
];
