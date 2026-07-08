import { z } from "zod";
import {
	type EmailHeader,
	ImapError,
	imapListRecent,
	imapReadMessage,
	imapSearch,
} from "$lib/server/services/connections/providers/imap";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import type { ToolEvidenceCandidate } from "$lib/types";

import { decideLocalDistill } from "./connector-distill";

export const emailToolInputSchema = z.object({
	action: z.enum(["recent", "search", "read"]),
	query: z.string().optional(),
	unseenOnly: z.boolean().optional(),
	uid: z.number().optional(),
});

export type EmailToolInput = z.infer<typeof emailToolInputSchema>;

export function sanitizeEmailToolInput(input: EmailToolInput): EmailToolInput {
	return {
		action: input.action,
		...(input.query ? { query: input.query.trim() } : {}),
		...(input.unseenOnly !== undefined ? { unseenOnly: input.unseenOnly } : {}),
		...(input.uid !== undefined ? { uid: input.uid } : {}),
	};
}

export type EmailCitation = { label: string; url: string };

// One message header as surfaced to the model. `from`/`subject`/`snippet` are
// the "raw message details" the locality Option-A distill gate (below)
// strips when active — mirrors the calendar tool keeping id/start/end while
// stripping summary/location, and the files tool keeping name/path/size while
// stripping `content`. `uid`/`date`/`seen` are structural metadata, not
// message content, and are never stripped.
export type EmailToolHeaderItem = {
	uid: number;
	from?: string;
	subject?: string;
	date: string;
	seen: boolean;
	snippet?: string;
};

export type EmailToolModelPayload = {
	success: boolean;
	name: "email";
	sourceType: "tool";
	action: EmailToolInput["action"];
	message: string;
	messages: EmailToolHeaderItem[];
	// Only present for a successful "read" — the full (capped) message body.
	text?: string;
	citations: EmailCitation[];
};

export type EmailToolOutcome = {
	modelPayload: EmailToolModelPayload;
	candidates: ToolEvidenceCandidate[];
};

function toToolHeaderItem(header: EmailHeader): EmailToolHeaderItem {
	return {
		uid: header.uid,
		...(header.from ? { from: header.from } : {}),
		...(header.subject ? { subject: header.subject } : {}),
		date: header.date,
		seen: header.seen,
		...(header.snippet ? { snippet: header.snippet } : {}),
	};
}

function subjectLabel(item: EmailToolHeaderItem): string {
	return item.subject && item.subject.length > 0
		? item.subject
		: "(no subject)";
}

// Email has no web URL to link to (unlike calendar's htmlLink or files' web UI
// deep link) — citations carry an empty `url` (non-linking) per the issue
// brief; the Sources tab shows the label without making it clickable.
function toCandidate(
	uid: number | undefined,
	citation: EmailCitation,
): ToolEvidenceCandidate {
	return {
		id: `email:${uid ?? citation.label}`,
		title: citation.label,
		url: citation.url,
		snippet: citation.label,
		sourceType: "tool",
	};
}

function buildPayload(params: {
	success: boolean;
	action: EmailToolInput["action"];
	message: string;
	messages?: EmailToolHeaderItem[];
	text?: string;
	citations?: EmailCitation[];
}): EmailToolOutcome {
	const messages = params.messages ?? [];
	const citations = params.citations ?? [];
	return {
		modelPayload: {
			success: params.success,
			name: "email",
			sourceType: "tool",
			action: params.action,
			message: params.message,
			messages,
			...(params.text !== undefined ? { text: params.text } : {}),
			citations,
		},
		candidates: citations.map((citation, index) =>
			toCandidate(messages[index]?.uid, citation),
		),
	};
}

function ambiguityNote(
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	const labels = connections.map((c) => c.label).join(", ");
	return `You have ${connections.length} Email connections (${labels}); using "${conn.label}" for this request.`;
}

function withAmbiguityPrefix(
	message: string,
	ambiguous: boolean,
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	return ambiguous ? `${ambiguityNote(conn, connections)} ${message}` : message;
}

function mapAdapterError(err: unknown): string {
	if (err instanceof ImapError) {
		switch (err.code) {
			case "needs_reauth":
				return "Your Email connection needs to be reconnected before I can access your mailbox. Please reconnect it in Settings.";
			case "connection_not_found":
				return "Your Email connection couldn't be found. Please reconnect it in Settings.";
			case "message_not_found":
				return "That email message couldn't be found.";
			default:
				return "I couldn't reach your email right now. Please try again in a moment.";
		}
	}
	return "I couldn't reach your email right now. Please try again in a moment.";
}

function listOutcome(
	conn: ConnectionPublic,
	action: "recent" | "search",
	headers: EmailHeader[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): EmailToolOutcome {
	const items = headers.map(toToolHeaderItem);
	const citations: EmailCitation[] = items.map((item) => ({
		label: subjectLabel(item),
		url: "",
	}));
	const message =
		items.length === 0
			? "No messages found."
			: `Found ${items.length} ${items.length === 1 ? "message" : "messages"}.`;
	return buildPayload({
		success: true,
		action,
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		messages: items,
		citations,
	});
}

function readOutcome(
	conn: ConnectionPublic,
	header: EmailHeader,
	text: string,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): EmailToolOutcome {
	const item = toToolHeaderItem(header);
	const citation: EmailCitation = { label: subjectLabel(item), url: "" };
	// Deliberately generic (no raw subject) — same posture as calendar.ts/
	// files.ts's base messages: the Option-A distill gate below only ever
	// appends to this string, so it must never itself carry raw message
	// content or that content would leak into the model payload even when
	// distillation strips `messages[].subject`/`text`.
	const message = withAmbiguityPrefix(
		"Read 1 message.",
		ambiguous,
		conn,
		connections,
	);
	return buildPayload({
		success: true,
		action: "read",
		message,
		messages: [item],
		text,
		citations: [citation],
	});
}

// Redacts the MODEL-FACING citation labels once Option A distillation has
// applied — same rationale as calendar.ts's redactCitationsForModel:
// citations[].label here is populated with the exact raw subject that Option
// A strips from `messages[].subject`, so leaving it untouched would let the
// raw subject reach the cloud model through `citations` even though
// `messages[].subject` was stripped two fields earlier in the same payload.
// `outcome.candidates` (the user's own Sources-tab list, built from the
// *original* unredacted citations before this gate ever runs) is left alone.
function redactCitationsForModel(
	messages: EmailToolHeaderItem[],
	citations: EmailCitation[],
): EmailCitation[] {
	return citations.map((citation, index) => {
		const date = messages[index]?.date;
		return {
			...citation,
			label: date ? `Email message at ${date}` : "Email message",
		};
	});
}

// Locality Option A: email is the most sensitive connector data this app
// handles — bodies, subjects, AND sender identities are all "raw message
// details" that must never reach a cloud model without the user's local-
// distillation opt-in producing a summary first. When active, this strips
// `from`/`subject`/`snippet` from every message, drops `text` entirely, and
// redacts `citations[].label` (see redactCitationsForModel) — i.e. the WHOLE
// model-facing payload, not just one field, matches the issue's "entire
// model payload must be distilled/redacted" requirement.
async function applyLocalDistillGate(params: {
	userId: string;
	modelId: string;
	input: EmailToolInput;
	outcome: EmailToolOutcome;
}): Promise<EmailToolOutcome> {
	const { userId, modelId, input, outcome } = params;
	if (!outcome.modelPayload.success) return outcome;

	const rawTextParts: string[] = [];
	for (const item of outcome.modelPayload.messages) {
		const descriptors = [item.from, item.subject].filter(
			(value): value is string => Boolean(value),
		);
		if (descriptors.length > 0) {
			rawTextParts.push(`${descriptors.join(" - ")} (${item.date})`);
		}
	}
	if (outcome.modelPayload.text) rawTextParts.push(outcome.modelPayload.text);
	// Nothing raw to protect (e.g. every message has an empty from/subject and
	// there's no body) — the gate is a no-op.
	if (rawTextParts.length === 0) return outcome;

	const decision = await decideLocalDistill({
		userId,
		modelId,
		capability: "email",
		userQuestion: input.query ?? "",
		rawText: rawTextParts.join("\n\n"),
	});
	if (!decision.shouldDistill) return outcome;

	const strippedMessages = outcome.modelPayload.messages.map((item) => {
		const { from: _from, subject: _subject, snippet: _snippet, ...rest } = item;
		return rest;
	});
	const redactedCitations = redactCitationsForModel(
		outcome.modelPayload.messages,
		outcome.modelPayload.citations,
	);

	if ("distilled" in decision) {
		return {
			...outcome,
			modelPayload: {
				...outcome.modelPayload,
				message: `${outcome.modelPayload.message} Privately summarized for a cloud model. Summary: ${decision.distilled}`,
				messages: strippedMessages,
				citations: redactedCitations,
				text: undefined,
			},
		};
	}

	return {
		...outcome,
		modelPayload: {
			...outcome.modelPayload,
			message:
				"This email couldn't be privately summarized for a cloud model, so its details were withheld. Switch to a local model to view them, or try again.",
			messages: strippedMessages,
			citations: redactedCitations,
			text: undefined,
		},
	};
}

// Resolves the user's Email (IMAP) connection(s) and executes a
// recent/search/read lookup, degrading gracefully (never throwing) so a
// connection problem never aborts the chat turn: no connection, ambiguity,
// and adapter failures all resolve to a `{ success: false, message }`-shaped
// payload instead. Read-only — SMTP send/write ops are Phase 6.3.
export async function runEmailTool(
	userId: string,
	input: EmailToolInput,
	modelId: string,
): Promise<EmailToolOutcome> {
	const connections = await resolveConnectionsForCapability(userId, "email");
	if (connections.length === 0) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have an Email connection set up yet. Connect your mailbox in Settings to check your email.",
		});
	}

	const ambiguous = needsDisambiguation(connections);
	const conn = connections[0];
	if (!conn) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have an Email connection set up yet. Connect your mailbox in Settings to check your email.",
		});
	}

	try {
		if (input.action === "recent") {
			const headers = await imapListRecent(userId, conn.id, {
				unseenOnly: input.unseenOnly,
			});
			const outcome = listOutcome(
				conn,
				"recent",
				headers,
				ambiguous,
				connections,
			);
			return applyLocalDistillGate({ userId, modelId, input, outcome });
		}

		if (input.action === "search") {
			if (!input.query) {
				return buildPayload({
					success: false,
					action: "search",
					message: "A search query is required to search your email.",
				});
			}
			const headers = await imapSearch(userId, conn.id, { query: input.query });
			const outcome = listOutcome(
				conn,
				"search",
				headers,
				ambiguous,
				connections,
			);
			return applyLocalDistillGate({ userId, modelId, input, outcome });
		}

		if (input.uid === undefined) {
			return buildPayload({
				success: false,
				action: "read",
				message: "A message uid is required to read an email.",
			});
		}
		const { header, text } = await imapReadMessage(userId, conn.id, {
			uid: input.uid,
		});
		const outcome = readOutcome(conn, header, text, ambiguous, connections);
		return applyLocalDistillGate({ userId, modelId, input, outcome });
	} catch (err) {
		return buildPayload({
			success: false,
			action: input.action,
			message: mapAdapterError(err),
		});
	}
}
