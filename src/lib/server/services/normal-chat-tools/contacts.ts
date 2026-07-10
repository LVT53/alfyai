import { z } from "zod";
import {
	type ContactMatch,
	resolveContacts,
	resolveContactsByGroup,
} from "$lib/server/services/connections/providers/contacts";
import { resolveConnectionsForCapability } from "$lib/server/services/connections/resolve";
import type { ToolEvidenceCandidate } from "$lib/types";

import { decideLocalDistill } from "./connector-distill";

// `query` is overloaded by `action` (kept as one field rather than two
// action-specific ones, matching the existing single-field shape): for
// "lookup" it's the name/email search text; for "group" (GAP B8) it's the
// contact-group's name, e.g. "Family" or "Work".
export const contactsToolInputSchema = z.object({
	action: z.enum(["lookup", "group"]),
	query: z.string(),
});

export type ContactsToolInput = z.infer<typeof contactsToolInputSchema>;

export function sanitizeContactsToolInput(
	input: ContactsToolInput,
): ContactsToolInput {
	return {
		action: input.action,
		query: input.query.trim(),
	};
}

export type ContactsCitation = { label: string; url: string };

// One contact as surfaced to the model. Every field here (name/emails/phones)
// is sensitive PII — unlike calendar.ts's event items (which keep structural
// id/start/end/htmlLink alongside the protected summary/location), a contact
// has no non-sensitive remainder, which is why the Option-A gate below wipes
// the whole array rather than stripping individual fields (see
// applyLocalDistillGate's doc comment).
export type ContactsToolContactItem = ContactMatch;

export type ContactsToolModelPayload = {
	success: boolean;
	name: "contacts";
	sourceType: "tool";
	action: "lookup" | "group";
	message: string;
	contacts: ContactsToolContactItem[];
	citations: ContactsCitation[];
};

export type ContactsToolOutcome = {
	modelPayload: ContactsToolModelPayload;
	candidates: ToolEvidenceCandidate[];
};

const MAX_MATCHES = 10;

function toCandidate(
	contact: ContactsToolContactItem,
	index: number,
): ToolEvidenceCandidate {
	const label = contact.name || "(unnamed contact)";
	return {
		id: `contacts:${index}:${label}`,
		title: label,
		url: "",
		snippet: [contact.name, contact.organization?.company, ...contact.emails]
			.filter(Boolean)
			.join(" · "),
		sourceType: "tool",
	};
}

function buildPayload(params: {
	success: boolean;
	action: ContactsToolInput["action"];
	message: string;
	contacts?: ContactsToolContactItem[];
}): ContactsToolOutcome {
	const contacts = params.contacts ?? [];
	const citations: ContactsCitation[] = contacts.map((contact) => ({
		label: contact.name || "(unnamed contact)",
		url: "",
	}));
	return {
		modelPayload: {
			success: params.success,
			name: "contacts",
			sourceType: "tool",
			action: params.action,
			message: params.message,
			contacts,
			citations,
		},
		candidates: contacts.map(toCandidate),
	};
}

function noMatchesMessage(query: string): string {
	return `No contact found matching "${query}".`;
}

function ambiguousMessage(count: number): string {
	return `Found ${count} matching contacts — ask the user which one they mean before using an email or phone number.`;
}

function noGroupMatchesMessage(groupName: string): string {
	return `No contacts found in a group matching "${groupName}".`;
}

function groupFoundMessage(count: number, groupName: string): string {
	return `Found ${count} contact${count === 1 ? "" : "s"} in the group matching "${groupName}".`;
}

// Redacts the MODEL-facing citation labels once Option A distillation has
// applied — same rationale as calendar.ts's redactCitationsForModel: the
// citation label is the raw contact name, a side channel the raw text must
// not leak through even after the `contacts` array itself is wiped.
function redactCitationsForModel(
	citations: ContactsCitation[],
): ContactsCitation[] {
	return citations.map((_citation, index) => ({
		label: `Contact ${index + 1}`,
		url: "",
	}));
}

// Locality Option A, "whole-payload" posture: unlike calendar.ts (which
// keeps non-sensitive structural fields like id/start/end/htmlLink alongside
// stripping only summary/location), a contact's name/emails/phones ARE the
// entire payload — there is no non-PII remainder worth keeping. So when
// Option A is active for a cloud model, the whole `contacts` array is wiped
// (not just individual fields) and citations are redacted to a
// non-identifying placeholder, replaced by a locally-distilled summary in
// `message`. `outcome.candidates` (the user's own Sources-tab list, built
// from the original unredacted contacts above, before this gate ever runs)
// is intentionally left untouched — it's the user's own data on their own
// screen, a different channel from what reaches the (cloud) model.
async function applyLocalDistillGate(params: {
	userId: string;
	modelId: string;
	input: ContactsToolInput;
	outcome: ContactsToolOutcome;
}): Promise<ContactsToolOutcome> {
	const { userId, modelId, input, outcome } = params;
	if (!outcome.modelPayload.success) return outcome;

	const rawTextParts = outcome.modelPayload.contacts
		.map((contact) =>
			[
				contact.name,
				...contact.emails,
				...contact.phones,
				contact.organization?.title,
				contact.organization?.company,
			]
				.filter((value): value is string => Boolean(value))
				.join(" / "),
		)
		.filter((value) => value.length > 0);
	// Nothing raw to protect (e.g. zero matches) — the gate is a no-op.
	if (rawTextParts.length === 0) return outcome;

	const decision = await decideLocalDistill({
		userId,
		modelId,
		capability: "contacts",
		userQuestion: input.query,
		rawText: rawTextParts.join("\n"),
	});
	if (!decision.shouldDistill) return outcome;

	const redactedCitations = redactCitationsForModel(
		outcome.modelPayload.citations,
	);

	if ("distilled" in decision) {
		return {
			...outcome,
			modelPayload: {
				...outcome.modelPayload,
				message: `${outcome.modelPayload.message} Privately summarized for a cloud model. Summary: ${decision.distilled}`,
				contacts: [],
				citations: redactedCitations,
			},
		};
	}

	return {
		...outcome,
		modelPayload: {
			...outcome.modelPayload,
			message:
				"These contacts couldn't be privately summarized for a cloud model, so their details were withheld. Switch to a local model to view them, or try again.",
			contacts: [],
			citations: redactedCitations,
		},
	};
}

// "group" action (GAP B8): resolves a named contact group ("Family",
// "Work", ...) across the user's contacts-capable connections (Google
// only, v1 — see resolveContactsByGroup's doc comment) instead of a
// name/email lookup. Every member is returned together — unlike "lookup",
// more than one result is NOT ambiguity to disambiguate, so this never uses
// ambiguousMessage.
async function runGroupLookup(
	userId: string,
	input: ContactsToolInput,
	modelId: string,
): Promise<ContactsToolOutcome> {
	let matches: ContactMatch[];
	try {
		matches = await resolveContactsByGroup(userId, {
			groupName: input.query,
			limit: MAX_MATCHES,
		});
	} catch {
		return buildPayload({
			success: false,
			action: "group",
			message:
				"I couldn't look up that contact group right now. Please try again in a moment.",
		});
	}

	if (matches.length === 0) {
		return buildPayload({
			success: true,
			action: "group",
			message: noGroupMatchesMessage(input.query),
		});
	}

	const outcome = buildPayload({
		success: true,
		action: "group",
		message: groupFoundMessage(matches.length, input.query),
		contacts: matches,
	});
	return applyLocalDistillGate({ userId, modelId, input, outcome });
}

// "lookup" action: resolves the user's name -> identity lookup across ALL
// of their contacts-capable connections (google + apple, via
// resolveContacts). Disambiguates when more than one distinct person
// matches.
async function runNameLookup(
	userId: string,
	input: ContactsToolInput,
	modelId: string,
): Promise<ContactsToolOutcome> {
	let matches: ContactMatch[];
	try {
		matches = await resolveContacts(userId, {
			query: input.query,
			limit: MAX_MATCHES,
		});
	} catch {
		return buildPayload({
			success: false,
			action: "lookup",
			message:
				"I couldn't look up your contacts right now. Please try again in a moment.",
		});
	}

	if (matches.length === 0) {
		return buildPayload({
			success: true,
			action: "lookup",
			message: noMatchesMessage(input.query),
		});
	}

	const outcome =
		matches.length === 1
			? buildPayload({
					success: true,
					action: "lookup",
					message: "Found 1 matching contact.",
					contacts: matches,
				})
			: buildPayload({
					success: true,
					action: "lookup",
					message: ambiguousMessage(matches.length),
					contacts: matches,
				});

	return applyLocalDistillGate({ userId, modelId, input, outcome });
}

// Dispatches to the "lookup" (name/email) or "group" (GAP B8) resolver,
// degrading gracefully (never throwing) so a connection or lookup problem
// never aborts the chat turn, and applying the same Option-A
// local-distillation posture as calendar.ts/email.ts before any raw PII
// reaches a cloud model.
export async function runContactsTool(
	userId: string,
	input: ContactsToolInput,
	modelId: string,
): Promise<ContactsToolOutcome> {
	const connections = await resolveConnectionsForCapability(userId, "contacts");
	if (connections.length === 0) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Contacts-capable connection set up yet. Connect your Google or Apple iCloud account in Settings to look up contacts.",
		});
	}

	if (input.action === "group") {
		return runGroupLookup(userId, input, modelId);
	}
	return runNameLookup(userId, input, modelId);
}
