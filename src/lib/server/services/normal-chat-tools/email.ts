import { z } from "zod";
import { withCapabilityConnection } from "$lib/server/services/connections/capability-read";
import { createPendingWrite } from "$lib/server/services/connections/pending-writes";
import {
	type EmailHeader,
	type ImapAttachment,
	ImapError,
	type ImapFolder,
	imapCount,
	imapGetInboxUidValidity,
	imapListFolders,
	imapListRecent,
	imapReadMessage,
	imapSearch,
} from "$lib/server/services/connections/providers/imap";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import {
	buildWritePreview,
	idempotencyKey,
	type WriteOperation,
	type WritePreview,
} from "$lib/server/services/connections/write-guard";
import type { ToolEvidenceCandidate } from "$lib/types";

import { applyLocalDistillGate, decideLocalDistill } from "./connector-distill";
import { noMatchingConnectionMessage } from "./shared";

export const emailToolInputSchema = z.object({
	action: z.enum([
		"recent",
		"search",
		"count",
		"read",
		"list_folders",
		"send",
		"trash",
		"flag",
	]),
	query: z.string().optional(),
	unseenOnly: z.boolean().optional(),
	uid: z.number().optional(),
	// Folder scoping (B4): which mailbox the read actions (recent/search/read/
	// count) operate on. Optional — defaults to INBOX. Resolved SPECIAL-USE-first
	// then by name, so "Sent"/"Archive"/a custom folder name all work; call the
	// "list_folders" action to discover the exact names the server exposes.
	folder: z.string().optional(),
	// Structured search/count filters (A2). All optional and AND together with
	// each other and with `query`: `from`/`subject` are sender/subject
	// substrings; `since`/`before` are date bounds ("YYYY-MM-DD" or ISO). Used
	// by the "search" and "count" actions. (`subject` is shared with the "send"
	// action below, where it is the composed subject instead.)
	from: z.string().optional(),
	since: z.string().optional(),
	before: z.string().optional(),
	// Write-action fields (6.3). `to`/`cc`/`subject`/`body`/`inReplyTo` are
	// "send"-only; `uid` doubles as "the message being replied to" for send
	// (optional) and "the target message" for trash/flag (required).
	// `flag`/`value` are "flag"-only.
	to: z.string().optional(),
	cc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string().optional(),
	inReplyTo: z.string().optional(),
	flag: z.enum(["seen", "flagged"]).optional(),
	value: z.boolean().optional(),
	// Multi-connection disambiguation — target ONE specific Email (IMAP)
	// connection when the user has more than one mailbox connected. A
	// provider name, a connection label, or the account identifier (email
	// address) all work — see selectConnection in resolve.ts. Omitted -> the
	// usual default (see pickDefaultConnection): a read uses the first
	// connection alphabetically; a write prefers a writes-enabled connection.
	account: z.string().optional(),
});

export type EmailToolInput = z.infer<typeof emailToolInputSchema>;

export function sanitizeEmailToolInput(input: EmailToolInput): EmailToolInput {
	return {
		action: input.action,
		...(input.query ? { query: input.query.trim() } : {}),
		...(input.unseenOnly !== undefined ? { unseenOnly: input.unseenOnly } : {}),
		...(input.uid !== undefined ? { uid: input.uid } : {}),
		...(input.folder ? { folder: input.folder.trim() } : {}),
		...(input.from ? { from: input.from.trim() } : {}),
		...(input.since ? { since: input.since.trim() } : {}),
		...(input.before ? { before: input.before.trim() } : {}),
		...(input.to ? { to: input.to.trim() } : {}),
		...(input.cc ? { cc: input.cc.trim() } : {}),
		...(input.subject ? { subject: input.subject.trim() } : {}),
		...(input.body ? { body: input.body.trim() } : {}),
		...(input.inReplyTo ? { inReplyTo: input.inReplyTo.trim() } : {}),
		...(input.flag ? { flag: input.flag } : {}),
		...(input.value !== undefined ? { value: input.value } : {}),
		...(input.account ? { account: input.account.trim() } : {}),
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

// One attachment's metadata as surfaced to the model (B5). Filename is
// message-derived content (it can reveal what an email is about), so it is
// treated as raw detail by the Option-A distill gate — dropped when active.
export type EmailToolAttachmentItem = {
	filename: string;
	contentType: string;
	size?: number;
};

// One mailbox folder as surfaced to the model (B4 list_folders). Folder
// names/paths are mailbox STRUCTURE, not message content (like counts), so
// they are never subject to the Option-A distill gate.
export type EmailToolFolderItem = {
	name: string;
	path: string;
	specialUse?: string;
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
	// Only present for a successful "read" (B5) — attachment metadata (filename/
	// contentType/size). Listing only; no bytes are downloaded.
	attachments?: EmailToolAttachmentItem[];
	// Only present for a successful "list_folders" (B4) — the account's mailboxes.
	folders?: EmailToolFolderItem[];
	// Only present for a successful "count" (A4) — the number of matching
	// messages (unread by default). Aggregate metadata, not raw message
	// content, so it is never subject to the Option-A distill gate.
	count?: number;
	citations: EmailCitation[];
	// Only set for a successful send/trash/flag action (6.3) — the write has
	// NOT executed, this is the id the user's confirm/cancel decision applies
	// to (mirrors calendar.ts/files.ts's own pendingWriteId).
	pendingWriteId?: string;
	preview?: WritePreview;
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
	attachments?: EmailToolAttachmentItem[];
	folders?: EmailToolFolderItem[];
	count?: number;
	citations?: EmailCitation[];
	pendingWriteId?: string;
	preview?: WritePreview;
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
			...(params.attachments !== undefined
				? { attachments: params.attachments }
				: {}),
			...(params.folders !== undefined ? { folders: params.folders } : {}),
			...(params.count !== undefined ? { count: params.count } : {}),
			citations,
			...(params.pendingWriteId
				? { pendingWriteId: params.pendingWriteId }
				: {}),
			...(params.preview ? { preview: params.preview } : {}),
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
	const other = connections.find((c) => c.id !== conn.id);
	return `You have ${connections.length} Email connections (${labels}); using "${conn.label}" for this request.${other ? ` Pass account:"${other.label}" to use ${other.label} instead.` : ""}`;
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

// A count (A4) surfaces only an aggregate number — no per-message rows,
// citations, or body text — so nothing here is raw message content and the
// Option-A distill gate never needs to run (it would be a no-op anyway with no
// from/subject/text present).
function countOutcome(
	conn: ConnectionPublic,
	count: number,
	kind: { unread: boolean; filtered: boolean },
	ambiguous: boolean,
	connections: ConnectionPublic[],
): EmailToolOutcome {
	const noun = count === 1 ? "message" : "messages";
	const message = kind.filtered
		? `${count} ${noun} match your search.`
		: kind.unread
			? `You have ${count} unread ${noun}.`
			: `You have ${count} ${noun}.`;
	return buildPayload({
		success: true,
		action: "count",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		count,
	});
}

function toAttachmentItem(att: ImapAttachment): EmailToolAttachmentItem {
	return {
		filename: att.filename,
		contentType: att.contentType,
		...(att.size !== undefined ? { size: att.size } : {}),
	};
}

function readOutcome(
	conn: ConnectionPublic,
	header: EmailHeader,
	text: string,
	attachments: ImapAttachment[],
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
		attachments: attachments.map(toAttachmentItem),
		citations: [citation],
	});
}

// A folder listing (B4) surfaces only mailbox structure — names, paths, and
// SPECIAL-USE flags — not message content, so like a count it carries no
// per-message rows/citations and never needs the Option-A distill gate.
function foldersOutcome(
	conn: ConnectionPublic,
	folders: ImapFolder[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): EmailToolOutcome {
	const items: EmailToolFolderItem[] = folders.map((f) => ({
		name: f.name,
		path: f.path,
		...(f.specialUse ? { specialUse: f.specialUse } : {}),
	}));
	const message =
		items.length === 0
			? "No folders found."
			: `Found ${items.length} ${items.length === 1 ? "folder" : "folders"}.`;
	return buildPayload({
		success: true,
		action: "list_folders",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		folders: items,
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
function distillEmailReadOutcome(params: {
	userId: string;
	modelId: string;
	input: EmailToolInput;
	outcome: EmailToolOutcome;
}): Promise<EmailToolOutcome> {
	const { userId, modelId, input, outcome } = params;

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
	// Attachment filenames (B5) are message-derived content too ("Q3-layoffs.pdf"
	// reveals what an email is about), so they count as raw detail that both
	// triggers the gate and is stripped below.
	for (const att of outcome.modelPayload.attachments ?? []) {
		rawTextParts.push(att.filename);
	}

	const strippedMessages = () =>
		outcome.modelPayload.messages.map((item) => {
			const {
				from: _from,
				subject: _subject,
				snippet: _snippet,
				...rest
			} = item;
			return rest;
		});
	const redactedCitations = () =>
		redactCitationsForModel(
			outcome.modelPayload.messages,
			outcome.modelPayload.citations,
		);

	return applyLocalDistillGate({
		outcome,
		userId,
		modelId,
		capability: "email",
		userQuestion: input.query ?? "",
		rawText: rawTextParts.join("\n\n"),
		onDistilled: (o, distilled) => ({
			...o,
			modelPayload: {
				...o.modelPayload,
				message: `${o.modelPayload.message} Privately summarized for a cloud model. Summary: ${distilled}`,
				messages: strippedMessages(),
				citations: redactedCitations(),
				text: undefined,
				attachments: undefined,
			},
		}),
		onUnavailable: (o) => ({
			...o,
			modelPayload: {
				...o.modelPayload,
				message:
					"This email couldn't be privately summarized for a cloud model, so its details were withheld. Switch to a local model to view them, or try again.",
				messages: strippedMessages(),
				citations: redactedCitations(),
				text: undefined,
				attachments: undefined,
			},
		}),
	});
}

// ---------------------------------------------------------------------------
// Write actions (Issue 6.3) — send/trash/flag. These NEVER execute a
// mutation: like calendar.ts's create/update/delete_event and files.ts's
// "save", each one builds a WriteOperation, runs it through buildWritePreview
// (4.1), and hands it to createPendingWrite (4.3), which persists a PENDING
// row and nothing more. The only path from here to an actual send/mailbox
// mutation is the user explicitly confirming via the confirm API — a
// separate request entirely, dispatched by the "imap" write-executor
// (providers/imap-write.ts) registered in Issue 6.3.
// ---------------------------------------------------------------------------

type EmailWriteAction = "send" | "trash" | "flag";

function isEmailWriteAction(
	action: EmailToolInput["action"],
): action is EmailWriteAction {
	return action === "send" || action === "trash" || action === "flag";
}

// title/to/subject/body are the user's own compose input this turn, not
// connector-read data — no locality distillation gate applies to them
// (Option A). If `uid` is given (composing a reply), the ORIGINAL message's
// subject is fetched purely to surface a human "Replying to ..." sentence —
// THAT fetched subject IS connector-read data, so it goes through the same
// Option-A gate as calendar.ts's update/delete preview redaction.
async function proposeSend(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: EmailToolInput,
	ambiguous: boolean,
	connections: ConnectionPublic[],
	modelId: string,
): Promise<EmailToolOutcome> {
	if (!input.to || !input.subject || !input.body) {
		return buildPayload({
			success: false,
			action: "send",
			message: "A recipient, subject, and body are required to send an email.",
		});
	}

	let rawReplySubject: string | undefined;
	if (input.uid !== undefined) {
		try {
			const { header } = await imapReadMessage(userId, conn.id, {
				uid: input.uid,
			});
			rawReplySubject = header.subject;
		} catch {
			// Best-effort only — a missing/unreadable original message never
			// blocks sending the reply itself.
		}
	}

	const content = {
		to: input.to,
		...(input.cc ? { cc: input.cc } : {}),
		subject: input.subject,
		body: input.body,
		...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
	};

	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "email.send",
		summary: `Send "${input.subject}" to ${input.to}`,
		target: { label: `${input.subject} → ${input.to}` },
		reversible: false, // A sent email cannot be unsent.
		destructive: false,
		// Folds the FULL send payload (to/cc/subject/body/inReplyTo) into the
		// idempotency hash — same rationale as calendar.ts's create_event:
		// target.label above only carries "subject → to", so two genuinely
		// different emails with the same subject+recipient but different
		// bodies would otherwise collide on the same idempotencyKey and
		// therefore the same deterministic Message-ID (imap-write.ts's
		// imapMessageIdForOp), causing a receiving server to treat the second
		// as a duplicate and silently drop it. A true retry of the identical
		// email still reuses `content` verbatim, so the fingerprint — and the
		// Message-ID — stay stable for that case.
		payloadFingerprint: JSON.stringify(content),
	};
	const preview = buildWritePreview(op);

	const { id: pendingWriteId } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: JSON.stringify(content),
		idempotencyKey: idempotencyKey(op),
		preview,
		conversationId,
	});

	// Option A: only the fetched original-message subject is connector-read
	// data — `preview`/the base message below never contain it, so nothing
	// needs redacting there; only this optional "replying to" sentence does.
	let replySegment = "";
	if (rawReplySubject) {
		const decision = await decideLocalDistill({
			userId,
			modelId,
			capability: "email",
			userQuestion: input.subject,
			rawText: rawReplySubject,
		});
		if (decision.shouldDistill) {
			replySegment =
				"distilled" in decision
					? ` Replying to a message privately summarized for a cloud model. Summary: ${decision.distilled}`
					: " This is a reply to an existing message whose details couldn't be privately summarized for a cloud model, so they were withheld.";
		} else {
			replySegment = ` Replying to "${rawReplySubject}".`;
		}
	}

	const message = withAmbiguityPrefix(
		`I've prepared an email to ${input.to} with subject "${input.subject}", but it has NOT been sent yet — it is PENDING and awaiting your explicit confirmation. Sending cannot be undone once confirmed.${replySegment}`,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action: "send",
		message,
		pendingWriteId,
		preview,
	});
}

// The subject of the uid being trashed is connector-read data (fetched from
// the mailbox), so it is redacted from the MODEL-facing preview/message under
// Option A + cloud — same posture as calendar.ts's update/delete preview. The
// pending write's stored (DB) preview keeps the real subject; only the copy
// returned in this outcome is ever redacted.
async function proposeTrash(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: EmailToolInput,
	ambiguous: boolean,
	connections: ConnectionPublic[],
	modelId: string,
): Promise<EmailToolOutcome> {
	if (input.uid === undefined) {
		return buildPayload({
			success: false,
			action: "trash",
			message: "A message uid is required to move a message to Trash.",
		});
	}

	let subject: string;
	let uidValidity: string | null;
	try {
		// Fix 3 (write-safety hardening) — UIDVALIDITY binding: capture
		// INBOX's current UIDVALIDITY alongside the header fetch, so
		// imap-write.ts can refuse to act on `uid` at execute time if the
		// epoch has since changed (see imapGetInboxUidValidity's doc comment).
		const [{ header }, capturedUidValidity] = await Promise.all([
			imapReadMessage(userId, conn.id, { uid: input.uid }),
			imapGetInboxUidValidity(userId, conn.id),
		]);
		subject = header.subject || "(no subject)";
		uidValidity = capturedUidValidity;
	} catch (err) {
		return buildPayload({
			success: false,
			action: "trash",
			message: mapAdapterError(err),
		});
	}

	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "email.trash",
		summary: `Move "${subject}" to Trash`,
		target: { id: String(input.uid), label: subject },
		reversible: true, // Goes to Trash, recoverable — not a permanent delete.
		destructive: true,
	};
	const rawPreview = buildWritePreview(op);

	const { id: pendingWriteId } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: JSON.stringify({
			uid: input.uid,
			...(uidValidity !== null ? { uidValidity } : {}),
		}),
		idempotencyKey: idempotencyKey(op),
		// The DB row keeps the RAW preview (real subject) — never sent back
		// through the model; only the copy below is.
		preview: rawPreview,
		conversationId,
	});

	const decision = await decideLocalDistill({
		userId,
		modelId,
		capability: "email",
		userQuestion: "",
		rawText: subject,
	});

	let modelPreview = rawPreview;
	let redactedNote = "";
	if (decision.shouldDistill) {
		modelPreview = {
			...rawPreview,
			title: "Move a message to Trash",
			detail: `${op.action} — email message`,
		};
		redactedNote =
			"distilled" in decision
				? ` Privately summarized for a cloud model. Summary: ${decision.distilled}`
				: " Its details couldn't be privately summarized for a cloud model, so they were withheld.";
	}

	const message = withAmbiguityPrefix(
		`I've prepared to move a message to Trash, but it has NOT been moved yet — it is PENDING and awaiting your explicit confirmation. ${modelPreview.detail}${redactedNote}${modelPreview.warnings.length > 0 && !decision.shouldDistill ? ` Warnings: ${modelPreview.warnings.join("; ")}.` : ""}`,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action: "trash",
		message,
		pendingWriteId,
		preview: modelPreview,
	});
}

// No connector read is needed to propose a flag change — the target is
// identified purely by uid, with no raw message content surfaced in the
// preview/message, so no Option-A gate applies here.
async function proposeFlag(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: EmailToolInput,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): Promise<EmailToolOutcome> {
	if (input.uid === undefined || !input.flag || input.value === undefined) {
		return buildPayload({
			success: false,
			action: "flag",
			message:
				"A message uid, flag name, and value are required to change a flag.",
		});
	}

	// Fix 3 (write-safety hardening) — UIDVALIDITY binding, same rationale as
	// proposeTrash above. A flag change has no other reason to open a
	// connection at propose time, but the safety property needs this capture
	// regardless.
	let uidValidity: string | null;
	try {
		uidValidity = await imapGetInboxUidValidity(userId, conn.id);
	} catch (err) {
		return buildPayload({
			success: false,
			action: "flag",
			message: mapAdapterError(err),
		});
	}

	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "email.flag",
		summary: `${input.value ? "Set" : "Clear"} ${input.flag} on a message`,
		target: { id: String(input.uid) },
		reversible: true,
		destructive: false,
	};
	const preview = buildWritePreview(op);

	const { id: pendingWriteId } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: JSON.stringify({
			uid: input.uid,
			flag: input.flag,
			value: input.value,
			...(uidValidity !== null ? { uidValidity } : {}),
		}),
		idempotencyKey: idempotencyKey(op),
		preview,
		conversationId,
	});

	const message = withAmbiguityPrefix(
		`I've prepared to ${input.value ? "set" : "clear"} the ${input.flag} flag on a message, but it has NOT been applied yet — it is PENDING and awaiting your explicit confirmation. ${preview.detail}`,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action: "flag",
		message,
		pendingWriteId,
		preview,
	});
}

async function emailWriteOutcome(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: EmailToolInput,
	action: EmailWriteAction,
	ambiguous: boolean,
	connections: ConnectionPublic[],
	modelId: string,
): Promise<EmailToolOutcome> {
	// Hard gate, checked BEFORE any secret is ever decrypted — same posture as
	// files.ts's saveOutcome / calendar.ts's calendarWriteOutcome. No pending
	// row is created when writes are disabled.
	if (conn.allowWrites !== true) {
		return buildPayload({
			success: false,
			action,
			message: `Writing to ${conn.label} is turned off; enable it in settings.`,
		});
	}

	if (action === "send") {
		return proposeSend(
			userId,
			conversationId,
			conn,
			input,
			ambiguous,
			connections,
			modelId,
		);
	}
	if (action === "trash") {
		return proposeTrash(
			userId,
			conversationId,
			conn,
			input,
			ambiguous,
			connections,
			modelId,
		);
	}
	return proposeFlag(
		userId,
		conversationId,
		conn,
		input,
		ambiguous,
		connections,
	);
}

// Collects the structured search/count criteria (A2) actually present on the
// input into a single object — only non-empty keys are included so the call
// matches imapSearch/imapCount's "no criteria -> no-op" contract, and callers
// can test presence with `Object.keys(...).length`.
function searchCriteria(input: EmailToolInput): {
	query?: string;
	from?: string;
	subject?: string;
	since?: string;
	before?: string;
} {
	return {
		...(input.query ? { query: input.query } : {}),
		...(input.from ? { from: input.from } : {}),
		...(input.subject ? { subject: input.subject } : {}),
		...(input.since ? { since: input.since } : {}),
		...(input.before ? { before: input.before } : {}),
	};
}

// Resolves the user's Email (IMAP) connection(s) and executes a
// recent/search/read lookup, or (6.3) proposes a send/trash/flag write,
// degrading gracefully (never throwing) so a connection problem never aborts
// the chat turn: no connection, ambiguity, and adapter failures all resolve
// to a `{ success: false, message }`-shaped payload instead.
export async function runEmailTool(
	userId: string,
	input: EmailToolInput,
	modelId: string,
	conversationId?: string,
): Promise<EmailToolOutcome> {
	const notConnectedMessage =
		"You don't have an Email connection set up yet. Connect your mailbox in Settings to check your email.";

	const result = await withCapabilityConnection(
		userId,
		"email",
		{ account: input.account, forWrite: isEmailWriteAction(input.action) },
		async (conn, { ambiguous, connections }): Promise<EmailToolOutcome> => {
			// Write actions (6.3) are proposal-only and branch here — before the
			// read-side try/catch below — same posture as calendar.ts's write branch
			// ahead of its shared range-resolution flow.
			if (isEmailWriteAction(input.action)) {
				return emailWriteOutcome(
					userId,
					conversationId,
					conn,
					input,
					input.action,
					ambiguous,
					connections,
					modelId,
				);
			}

			try {
				// B4: enumerate the account's mailboxes so the model can discover folder
				// names and resolve "Sent"/"Archive"/… — pure structure, no message read.
				if (input.action === "list_folders") {
					const folders = await imapListFolders(userId, conn.id);
					return foldersOutcome(conn, folders, ambiguous, connections);
				}

				if (input.action === "recent") {
					const headers = await imapListRecent(userId, conn.id, {
						unseenOnly: input.unseenOnly,
						...(input.folder ? { folder: input.folder } : {}),
					});
					const outcome = listOutcome(
						conn,
						"recent",
						headers,
						ambiguous,
						connections,
					);
					return distillEmailReadOutcome({ userId, modelId, input, outcome });
				}

				if (input.action === "search") {
					// A2: a search is valid with free text OR any structured filter
					// (sender/subject/date) — "emails from Anna" needs no `query`.
					const criteria = searchCriteria(input);
					if (Object.keys(criteria).length === 0) {
						return buildPayload({
							success: false,
							action: "search",
							message:
								"A search query is required (or a sender, subject, or date filter) to search your email.",
						});
					}
					const headers = await imapSearch(userId, conn.id, {
						...criteria,
						...(input.folder ? { folder: input.folder } : {}),
					});
					const outcome = listOutcome(
						conn,
						"search",
						headers,
						ambiguous,
						connections,
					);
					return distillEmailReadOutcome({ userId, modelId, input, outcome });
				}

				if (input.action === "count") {
					// A4: an accurate count of matching UIDs (never bounded by the list
					// cap). Defaults to counting UNREAD ("how many unread emails do I
					// have?") when no explicit unseenOnly and no search filter is given;
					// an explicit `unseenOnly: false` counts the whole mailbox, and any
					// filter switches to counting the matching search.
					const criteria = searchCriteria(input);
					const filtered = Object.keys(criteria).length > 0;
					const unseenOnly = input.unseenOnly ?? (filtered ? undefined : true);
					const count = await imapCount(userId, conn.id, {
						...criteria,
						...(unseenOnly !== undefined ? { unseenOnly } : {}),
						...(input.folder ? { folder: input.folder } : {}),
					});
					return countOutcome(
						conn,
						count,
						{ unread: unseenOnly === true, filtered },
						ambiguous,
						connections,
					);
				}

				if (input.uid === undefined) {
					return buildPayload({
						success: false,
						action: "read",
						message: "A message uid is required to read an email.",
					});
				}
				const { header, text, attachments } = await imapReadMessage(
					userId,
					conn.id,
					{
						uid: input.uid,
						...(input.folder ? { folder: input.folder } : {}),
					},
				);
				const outcome = readOutcome(
					conn,
					header,
					text,
					attachments,
					ambiguous,
					connections,
				);
				return distillEmailReadOutcome({ userId, modelId, input, outcome });
			} catch (err) {
				return buildPayload({
					success: false,
					action: input.action,
					message: mapAdapterError(err),
				});
			}
		},
	);

	if (result.kind === "not-connected") {
		return buildPayload({
			success: false,
			action: input.action,
			message: notConnectedMessage,
		});
	}
	if (result.kind === "no-match") {
		return buildPayload({
			success: false,
			action: input.action,
			message: noMatchingConnectionMessage(
				"Email",
				result.selector,
				result.connections,
			),
		});
	}
	return result.value;
}
