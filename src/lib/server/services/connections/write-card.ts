import { isPhotoProxyPath } from "$lib/shared/artifacts/block-urls";
import type {
	PendingWrite,
	WriteCard,
	WriteCardFact,
	WriteCardKind,
	WriteCardRisk,
} from "./pending-write-dto";
import type { PendingWriteRecord } from "./pending-writes";
import { isPendingWriteExpired } from "./pending-writes";
import { WRITE_WARNING, type WriteOperation } from "./write-guard";

// What the permission card says about a pending write. It reads the row's own
// operation and payload, the same two things the executor runs on confirm, so
// the card cannot show one thing and do another: a preview written at proposal
// time is a description, and this is the write itself.
//
// Never reaches a model. A tool hands the model its `preview` when it proposes a
// write, with connector-read text redacted for a cloud model; this is built on
// read, for the person's own screen, from a row only they can load.

/** An email's text past this is cut for the card. The email itself is not. */
const MESSAGE_LIMIT = 8_000;

/** An event's new notes get a line, not a page: the line says they change and how they begin. */
const NOTES_LIMIT = 120;

/** A strip of the photos, not the whole set: the count says how many. */
const THUMBNAIL_LIMIT = 8;

function parseObject(content: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(content);
		return parsed !== null && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function fact(key: WriteCardFact["key"], value: unknown): WriteCardFact[] {
	const shown = text(value);
	return shown ? [{ key, value: shown }] : [];
}

function fileName(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}

function parentFolder(path: string): string {
	const segments = path.split("/").filter(Boolean);
	return `/${segments.slice(0, -1).join("/")}`;
}

function cut(value: unknown, limit: number): string | null {
	const shown = text(value);
	if (!shown) return null;
	return shown.length > limit ? `${shown.slice(0, limit).trimEnd()}…` : shown;
}

const NAMED_ADDRESS = /^\s*"?(.*?)"?\s*<([^<>]*)>\s*$/;

/** "Anna Kovács <anna@example.com>" by the name a mail app shows; an address alone as it is. */
function senderName(from: unknown): string | null {
	const shown = text(from);
	if (!shown) return null;
	const named = NAMED_ADDRESS.exec(shown);
	if (!named) return shown.trim();
	return named[1]?.trim() || named[2]?.trim() || null;
}

// Who sent an email and when it came, read off the mailbox when the write was
// proposed: many emails share a subject, and the card is how the person tells
// which one this is.
function receivedFacts(
	payload: Record<string, unknown> | null,
): WriteCardFact[] {
	const from = senderName(payload?.from);
	return [
		...(from ? [{ key: "from" as const, value: from }] : []),
		...fact("sent", payload?.date),
	];
}

function emailCard(
	op: WriteOperation,
	content: string,
): Omit<WriteCard, "risks" | "danger"> | null {
	const payload = parseObject(content);
	if (op.action === "email.send") {
		const subject = text(payload?.subject);
		if (!subject || !text(payload?.to)) return null;
		return {
			kind: "email.send",
			subject,
			facts: [...fact("to", payload?.to), ...fact("cc", payload?.cc)],
			message: cut(payload?.body, MESSAGE_LIMIT),
		};
	}
	if (op.action === "email.trash") {
		return {
			kind: "email.trash",
			subject: text(op.target?.label) ?? "",
			facts: receivedFacts(payload),
			message: null,
		};
	}
	if (op.action === "email.flag") {
		const flagKind: Record<string, WriteCardKind> = {
			"seen:true": "email.mark_read",
			"seen:false": "email.mark_unread",
			"flagged:true": "email.flag",
			"flagged:false": "email.unflag",
		};
		const kind = flagKind[`${payload?.flag}:${payload?.value}`];
		return kind
			? {
					kind,
					subject: text(op.target?.label) ?? "",
					facts: receivedFacts(payload),
					message: null,
				}
			: null;
	}
	return null;
}

function eventWhen(
	event: Record<string, unknown>,
	key: "when" | "new_when" = "when",
): WriteCardFact[] {
	const start = text(event.start);
	if (!start) return [];
	const end = text(event.end);
	return [{ key, value: start, ...(end ? { end } : {}) }];
}

// One moment can be written two ways ("08:00Z", "09:00+01:00"), and that is no
// change. A bare day is compared as it is written.
function sameTime(a: string | null, b: string | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	const left = Date.parse(a);
	return !Number.isNaN(left) && left === Date.parse(b);
}

// What an update changes, against the event as it stood when it was proposed.
// Google's payload holds only the fields it sends and Apple's the whole event,
// so a field counts where it differs and nowhere else.
function eventChanges(
	current: Record<string, unknown>,
	event: Record<string, unknown>,
): WriteCardFact[] {
	const changes: WriteCardFact[] = [];
	const name = text(event.summary);
	if (name && name !== text(current.summary)) {
		changes.push({ key: "new_name", value: name });
	}
	const start = text(event.start) ?? text(current.start);
	const end = text(event.end) ?? text(current.end);
	const moved =
		!sameTime(start, text(current.start)) || !sameTime(end, text(current.end));
	if (moved) {
		changes.push(...eventWhen({ start, end }, "new_when"));
	}
	const place = text(event.location);
	if (place && place !== text(current.location)) {
		changes.push({ key: "new_where", value: place });
	}
	const notes = text(event.description);
	if (notes && notes !== text(current.description)) {
		changes.push({ key: "new_notes", value: cut(notes, NOTES_LIMIT) ?? notes });
	}
	return changes;
}

function calendarCard(
	op: WriteOperation,
	content: string,
): Omit<WriteCard, "risks" | "danger"> | null {
	const payload = parseObject(content);
	const event = (payload?.event ?? {}) as Record<string, unknown>;
	const label = text(op.target?.label) ?? "";
	const kinds: Record<string, WriteCardKind> = {
		"calendar.create_event": "calendar.create_event",
		"calendar.update_event": "calendar.update_event",
		"calendar.delete_event": "calendar.delete_event",
	};
	const kind = kinds[op.action];
	if (!kind || !payload) return null;

	// An update or a delete keeps the event as it stood beside its payload: a
	// delete carries no event of its own, and an update only what it changes, so
	// without it the card could not say which event this is. A row stored before
	// it was kept reads as it always did.
	const current =
		kind !== "calendar.create_event" &&
		payload.current !== null &&
		typeof payload.current === "object"
			? (payload.current as Record<string, unknown>)
			: null;
	if (!current) {
		return {
			kind,
			subject: label,
			facts: [...eventWhen(event), ...fact("where", event.location)],
			message: null,
		};
	}
	return {
		kind,
		// The event's own name: a title the request carried names nothing yet.
		subject: text(current.summary) ?? label,
		facts:
			kind === "calendar.delete_event"
				? [...eventWhen(current), ...fact("where", current.location)]
				: [...eventWhen(current), ...eventChanges(current, event)],
		message: null,
	};
}

function filesCard(
	op: WriteOperation,
	content: string,
): Omit<WriteCard, "risks" | "danger"> | null {
	const path = text(op.target?.path);
	if (!path) return null;
	const name = fileName(path);
	// The card names the file and says where it is. A whole path is a thing to
	// read twice, and most of it says what the next line already said.
	const inFolder: WriteCardFact[] = [
		{ key: "folder", value: parentFolder(path) },
	];

	switch (op.action) {
		case "files.put":
			return {
				kind: op.destructive ? "files.replace" : "files.save",
				subject: name,
				facts: inFolder,
				message: null,
			};
		case "files.delete":
			return {
				kind: "files.delete",
				subject: name,
				facts: inFolder,
				message: null,
			};
		case "files.create_folder":
			return {
				kind: "files.create_folder",
				subject: name,
				facts: inFolder,
				message: null,
			};
		case "files.share_link":
			return {
				kind: "files.share_link",
				subject: name,
				facts: inFolder,
				message: null,
			};
		case "files.move": {
			const fromPath = text(parseObject(content)?.fromPath);
			if (!fromPath) return null;
			const fromName = fileName(fromPath);
			const fromFolder = parentFolder(fromPath);
			const toFolder = parentFolder(path);
			const moved = fromFolder !== toFolder;
			return {
				kind: moved ? "files.move" : "files.rename",
				subject: fromName,
				facts: [
					...(fromName !== name
						? [{ key: "new_name" as const, value: name }]
						: []),
					{
						key: "folder",
						value: moved ? `${fromFolder} → ${toFolder}` : toFolder,
					},
				],
				message: null,
			};
		}
		default:
			return null;
	}
}

function photosCard(
	op: WriteOperation,
	content: string,
	connectionId: string,
): Omit<WriteCard, "risks" | "danger"> | null {
	if (op.action !== "immich.add_to_album") return null;
	const payload = parseObject(content);
	const album = text(payload?.albumName);
	const assetIds = payload?.assetIds;
	if (!album || !Array.isArray(assetIds)) return null;
	// Each through the app's own proxy for the row's account, the one a confirm
	// runs against, and the one image address a board may load too
	// (block-urls.ts): the ids came from the model, and an id the route would
	// refuse is left out rather than sent.
	const thumbnails = assetIds
		.map((id) =>
			typeof id === "string"
				? `/api/connections/immich/thumbnail/${id}?connectionId=${encodeURIComponent(connectionId)}`
				: null,
		)
		.filter(isPhotoProxyPath)
		.slice(0, THUMBNAIL_LIMIT);
	return {
		kind: "photos.add_to_album",
		subject: album,
		facts: [{ key: "photos", value: String(assetIds.length) }],
		message: null,
		thumbnails,
	};
}

// The warnings a write's preview can carry, as the card names them. Only what a
// person would want to know before saying yes: that a check could not run is a
// matter for the model and the logs, and the generic "may not be recoverable"
// gives way to the one that says what is lost.
const RISK_BY_WARNING = new Map<string, WriteCardRisk>([
	[WRITE_WARNING.noVersionHistory, "replaces_file_for_good"],
	[WRITE_WARNING.versionHistoryUnknown, "replaces_file_unchecked"],
	[WRITE_WARNING.publicLink, "public_link"],
	[WRITE_WARNING.outsideArea, "outside_allowed_folders"],
]);

function risksOf(
	record: Pick<PendingWriteRecord, "op" | "content" | "preview">,
): WriteCardRisk[] {
	const { op, preview } = record;
	const risks = preview.warnings.flatMap((warning) => {
		const risk = RISK_BY_WARNING.get(warning);
		return risk ? [risk] : [];
	});

	if (op.action.startsWith("calendar.")) {
		const payload = parseObject(record.content);
		const wholeSeries =
			payload?.recurringScope === "series" || payload?.recurring === true;
		if (wholeSeries) {
			risks.unshift(
				op.action === "calendar.update_event"
					? "changes_whole_series"
					: "deletes_whole_series",
			);
		}
		// Adding an event undoes by deleting it, whatever the platform keeps.
		if (op.destructive && !op.reversible) risks.push("cannot_undo");
	}
	return risks;
}

// Red means something is gone or overwritten for the reader. A Google event
// edit is "destructive" to the write guard, which is right for its own purpose,
// but the platform keeps its history and the word on the button is "Save".
function isDanger(op: WriteOperation): boolean {
	if (op.action === "calendar.update_event" && op.reversible) return false;
	return op.destructive;
}

/** The card for a stored write, or null for one this version cannot read: the card then falls back to the sentence the write was proposed with. */
export function buildWriteCard(
	record: Pick<
		PendingWriteRecord,
		"op" | "content" | "preview" | "connectionId"
	>,
): WriteCard | null {
	const { op, content } = record;
	if (!op?.action) return null;
	const card =
		emailCard(op, content) ??
		calendarCard(op, content) ??
		filesCard(op, content) ??
		photosCard(op, content, record.connectionId);
	if (!card) return null;
	return { ...card, risks: risksOf(record), danger: isDanger(op) };
}

/** A stored write as the person's page reads it. */
export function toPendingWriteDto(
	record: PendingWriteRecord,
	accountByConnectionId: ReadonlyMap<string, string>,
): PendingWrite {
	return {
		id: record.id,
		assistantMessageId: record.assistantMessageId,
		conversationId: record.conversationId,
		// A row past its TTL is still stored as "pending" — nothing sweeps
		// the table, the status only moves when a confirm walks into it.
		// Reported as-is, the card would offer buttons the server is guaranteed
		// to refuse. Project the state the confirm chokepoint would give it,
		// using that same predicate, so a reload shows "expired" immediately
		// instead of after a pointless click.
		status:
			record.status === "pending" && isPendingWriteExpired(record.expiresAt)
				? "expired"
				: record.status,
		preview: record.preview,
		card: buildWriteCard(record),
		account: accountByConnectionId.get(record.connectionId) ?? null,
		provider: record.provider,
		// PendingWriteRecord.createdAt is UNIX seconds (pending-writes.ts's
		// toRecord); every other client-facing timestamp (ChatMessage,
		// FileProductionJob) is epoch milliseconds — MessageArea's
		// getPendingWritesForMessage compares this against message.timestamp,
		// so it's converted to ms here at the API boundary rather than
		// leaking the seconds-vs-ms mismatch into client code.
		createdAt: record.createdAt * 1000,
	};
}
