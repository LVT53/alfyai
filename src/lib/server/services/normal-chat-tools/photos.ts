import { z } from "zod";
import { createPendingWrite } from "$lib/server/services/connections/pending-writes";
import {
	ImmichError,
	immichSmartSearch,
	type PhotoResult,
} from "$lib/server/services/connections/providers/immich";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import {
	buildWritePreview,
	idempotencyKey,
	type WriteOperation,
	type WritePreview,
} from "$lib/server/services/connections/write-guard";
import type { ToolEvidenceCandidate } from "$lib/types";

import { decideLocalDistill } from "./connector-distill";

export const photosToolInputSchema = z.object({
	action: z.enum(["search", "add_to_album"]),
	query: z.string().optional(),
	limit: z.number().optional(),
	// Write-action field (6.4) — ids the user is referring to from a prior
	// search this turn/session (opaque Immich asset ids, never filenames).
	assetIds: z.array(z.string()).optional(),
});

export type PhotosToolInput = z.infer<typeof photosToolInputSchema>;

export function sanitizePhotosToolInput(
	input: PhotosToolInput,
): PhotosToolInput {
	return {
		action: input.action,
		...(input.query !== undefined ? { query: input.query.trim() } : {}),
		...(input.limit !== undefined ? { limit: input.limit } : {}),
		...(input.assetIds !== undefined
			? { assetIds: input.assetIds.map((id) => id.trim()).filter(Boolean) }
			: {}),
	};
}

export type PhotoCitation = { label: string; url: string };

// One photo as surfaced to the model. `place`/`people`/`description` are the
// "raw photo details" the locality Option-A distill gate (below) strips when
// active — mirrors calendar.ts keeping id/start/end while stripping summary/
// location. `id`/`takenAt`/`type` are structural metadata, never stripped.
// `fileName` is also treated as raw (unlike, say, the files tool's filename)
// because an Immich original filename routinely embeds a date/location/event
// name (e.g. "hospital-visit.jpg") — see the issue's Option-A test.
export type PhotoToolResultItem = {
	id: string;
	fileName?: string;
	takenAt: string;
	type: "IMAGE" | "VIDEO";
	place?: string;
	people?: string[];
	description?: string;
};

export type PhotosToolModelPayload = {
	success: boolean;
	name: "photos";
	sourceType: "tool";
	action: PhotosToolInput["action"];
	message: string;
	results: PhotoToolResultItem[];
	citations: PhotoCitation[];
	// Only set for a successful add_to_album action (6.4) — the write has NOT
	// executed, this is the id the user's confirm/cancel decision applies to
	// (mirrors calendar.ts's create_event/update_event/delete_event).
	pendingWriteId?: string;
	preview?: WritePreview;
};

export type PhotosToolOutcome = {
	modelPayload: PhotosToolModelPayload;
	candidates: ToolEvidenceCandidate[];
};

function toToolResultItem(photo: PhotoResult): PhotoToolResultItem {
	return {
		id: photo.id,
		fileName: photo.fileName,
		takenAt: photo.takenAt,
		type: photo.type,
		...(photo.place ? { place: photo.place } : {}),
		...(photo.people && photo.people.length > 0
			? { people: photo.people }
			: {}),
		...(photo.description ? { description: photo.description } : {}),
	};
}

function citationLabel(item: PhotoToolResultItem): string {
	if (item.fileName) return item.fileName;
	if (item.description) return item.description;
	return "(photo)";
}

// Sources-tab candidate — keeps the real filename/thumbnailPath (the user's
// own data on their own screen), distinct from the model-facing citation
// label which the Option-A gate below may redact.
function toCandidate(
	photo: PhotoResult,
	citation: PhotoCitation,
): ToolEvidenceCandidate {
	return {
		id: `photos:${photo.id}`,
		title: citation.label,
		url: citation.url,
		snippet: citation.label,
		sourceType: "tool",
		metadata: { thumbnailPath: photo.thumbnailPath },
	};
}

function buildPayload(params: {
	success: boolean;
	action: PhotosToolInput["action"];
	message: string;
	results?: PhotoToolResultItem[];
	citations?: PhotoCitation[];
	candidates?: ToolEvidenceCandidate[];
	pendingWriteId?: string;
	preview?: WritePreview;
}): PhotosToolOutcome {
	const citations = params.citations ?? [];
	return {
		modelPayload: {
			success: params.success,
			name: "photos",
			sourceType: "tool",
			action: params.action,
			message: params.message,
			results: params.results ?? [],
			citations,
			...(params.pendingWriteId
				? { pendingWriteId: params.pendingWriteId }
				: {}),
			...(params.preview ? { preview: params.preview } : {}),
		},
		candidates: params.candidates ?? [],
	};
}

function ambiguityNote(
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	const labels = connections.map((c) => c.label).join(", ");
	return `You have ${connections.length} Photos connections (${labels}); using "${conn.label}" for this request.`;
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
	if (err instanceof ImmichError) {
		switch (err.code) {
			case "needs_reauth":
				return "Your Immich connection needs to be reconnected before I can access your photos. Please reconnect it in Settings.";
			case "connection_not_found":
				return "Your Immich connection couldn't be found. Please reconnect it in Settings.";
			default:
				return "I couldn't reach your photos right now. Please try again in a moment.";
		}
	}
	return "I couldn't reach your photos right now. Please try again in a moment.";
}

function searchOutcome(
	conn: ConnectionPublic,
	photos: PhotoResult[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): PhotosToolOutcome {
	const items = photos.map(toToolResultItem);
	const citations: PhotoCitation[] = items.map((item) => ({
		label: citationLabel(item),
		url: "",
	}));
	const candidates = photos.map((photo, index) => {
		const citation = citations[index] as PhotoCitation;
		return toCandidate(photo, citation);
	});
	const message =
		items.length === 0
			? "No photos found for that search."
			: `Found ${items.length} ${items.length === 1 ? "photo" : "photos"}.`;
	return buildPayload({
		success: true,
		action: "search",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		results: items,
		citations,
		candidates,
	});
}

// Redacts the MODEL-FACING citation labels once Option A distillation has
// applied — same rationale as calendar.ts's/email.ts's redactCitationsForModel:
// citations[].label here is populated with the exact raw fileName/description
// that Option A strips from `results[]`, so leaving it untouched would let
// the raw filename reach the cloud model through `citations` even though
// `results[].fileName` was stripped two fields earlier in the same payload.
// `outcome.candidates` (the user's own Sources-tab list, built from the
// *original* unredacted photos before this gate ever runs) is left alone.
function redactCitationsForModel(
	results: PhotoToolResultItem[],
	citations: PhotoCitation[],
): PhotoCitation[] {
	return citations.map((citation, index) => {
		const takenAt = results[index]?.takenAt;
		return {
			...citation,
			label: takenAt ? `Photo taken at ${takenAt}` : "Photo",
		};
	});
}

// Locality Option A: photo metadata (filenames, places, people names,
// descriptions) is sensitive personal data — when the user has opted in to
// local distillation and the selected chat model is cloud, replace it with a
// summary produced by a local model before it reaches the (cloud) model.
// This strips `fileName`/`place`/`people`/`description` from every result,
// and redacts `citations[].label` (see redactCitationsForModel) — i.e. the
// WHOLE model-facing payload, not just one field. `outcome.candidates` (the
// Sources-tab list) is untouched: it feeds the user's own screen, a
// different channel from what the model sees, and keeps the real data so
// thumbnails can still render.
async function applyLocalDistillGate(params: {
	userId: string;
	modelId: string;
	input: PhotosToolInput;
	outcome: PhotosToolOutcome;
}): Promise<PhotosToolOutcome> {
	const { userId, modelId, input, outcome } = params;
	if (!outcome.modelPayload.success) return outcome;

	const rawTextParts = outcome.modelPayload.results
		.map((item) => {
			const descriptors = [item.fileName, item.place, item.description].filter(
				(value): value is string => Boolean(value),
			);
			const people =
				item.people && item.people.length > 0
					? item.people.join(", ")
					: undefined;
			const allDescriptors = people ? [...descriptors, people] : descriptors;
			if (allDescriptors.length === 0) return null;
			return `${allDescriptors.join(" — ")} (${item.takenAt})`;
		})
		.filter((value): value is string => Boolean(value));
	// Nothing raw to protect (e.g. every result is bare metadata with no
	// filename/place/people/description) — the gate is a no-op.
	if (rawTextParts.length === 0) return outcome;

	const decision = await decideLocalDistill({
		userId,
		modelId,
		capability: "photos",
		userQuestion: input.query ?? "",
		rawText: rawTextParts.join("\n"),
	});
	if (!decision.shouldDistill) return outcome;

	const strippedResults = outcome.modelPayload.results.map((item) => {
		const {
			fileName: _fileName,
			place: _place,
			people: _people,
			description: _description,
			...rest
		} = item;
		return rest;
	});
	// Redact only the MODEL-facing copy — `outcome.candidates` (the
	// user-facing Sources-tab list) was already built from the original,
	// unredacted photos in `searchOutcome` and is untouched by this gate.
	const redactedCitations = redactCitationsForModel(
		outcome.modelPayload.results,
		outcome.modelPayload.citations,
	);

	if ("distilled" in decision) {
		return {
			...outcome,
			modelPayload: {
				...outcome.modelPayload,
				message: `${outcome.modelPayload.message} Privately summarized for a cloud model. Summary: ${decision.distilled}`,
				results: strippedResults,
				citations: redactedCitations,
			},
		};
	}

	return {
		...outcome,
		modelPayload: {
			...outcome.modelPayload,
			message:
				"These photos couldn't be privately summarized for a cloud model, so their details were withheld. Switch to a local model to view them, or try again.",
			results: strippedResults,
			citations: redactedCitations,
		},
	};
}

// ---------------------------------------------------------------------------
// Write action (Issue 6.4) — add_to_album. Like calendar.ts's create/update/
// delete_event, this NEVER executes a mutation inline: it builds a
// WriteOperation, runs it through buildWritePreview (4.1), and hands it to
// createPendingWrite (4.3), which persists a PENDING row and nothing more.
// The only path from here to an actual Immich album mutation is the user
// explicitly confirming via the confirm API, dispatched by the "immich"
// write-executor (providers/immich-write.ts, Issue 6.4).
//
// `input.assetIds` are OPAQUE Immich asset ids the model is referring to from
// a prior search this turn/session — this action never looks up or embeds a
// filename for them, so (unlike calendar.ts's update/delete_event, which
// reads an existing event's summary/location off the connector) there is no
// raw connector text in this preview/message for the locality Option-A gate
// to strip: the target label is always the static "AlfyAI album", and the
// summary only ever states a COUNT of photos, never a name. This is a
// structural guarantee, not a runtime distill decision — verified in
// photos.test.ts by asserting no filename from a prior search ever appears
// anywhere in the resulting payload.
const ALBUM_NAME = "AlfyAI";

async function proposeAddToAlbum(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: PhotosToolInput,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): Promise<PhotosToolOutcome> {
	if (!input.assetIds || input.assetIds.length === 0) {
		return buildPayload({
			success: false,
			action: "add_to_album",
			message:
				"At least one photo (from a prior search) is required to add to an album.",
		});
	}

	// Hard gate, checked BEFORE any secret decrypt — same posture as
	// calendarWriteOutcome/saveOutcome: nothing below this line runs, and no
	// pending row is created, when writes are disabled.
	if (conn.allowWrites !== true) {
		return buildPayload({
			success: false,
			action: "add_to_album",
			message: `Writing to ${conn.label} is turned off; enable it in settings.`,
		});
	}
	// A write-scoped key (Issue 6.4's enable-writes flow) is a SEPARATE
	// provisioning step from allowWrites — a connection that only ever
	// completed the read-only 5.5 connect flow has nothing to write with.
	if (!conn.hasWriteSecret) {
		return buildPayload({
			success: false,
			action: "add_to_album",
			message:
				"Enable Immich writes (re-enter your password) in settings first.",
		});
	}

	const count = input.assetIds.length;
	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "immich.add_to_album",
		summary: `Add ${count} ${count === 1 ? "photo" : "photos"} to the "${ALBUM_NAME}" album`,
		reversible: true, // Removing a photo from an album never touches the asset.
		destructive: false,
		target: { label: `${ALBUM_NAME} album` },
		payloadFingerprint: JSON.stringify({
			assetIds: [...input.assetIds].sort(),
			albumName: ALBUM_NAME,
		}),
	};
	const preview = buildWritePreview(op);

	const { id: pendingWriteId } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: JSON.stringify({
			assetIds: input.assetIds,
			albumName: ALBUM_NAME,
		}),
		idempotencyKey: idempotencyKey(op),
		preview,
		conversationId,
	});

	const message = withAmbiguityPrefix(
		`I've prepared ${count} ${count === 1 ? "photo" : "photos"} to be added to your "${ALBUM_NAME}" album, but it has NOT been applied yet — it is PENDING and awaiting your explicit confirmation. ${preview.detail}${preview.warnings.length > 0 ? ` Warnings: ${preview.warnings.join("; ")}.` : ""}`,
		ambiguous,
		conn,
		connections,
	);
	return buildPayload({
		success: true,
		action: "add_to_album",
		message,
		pendingWriteId,
		preview,
	});
}

// Resolves the user's Photos (Immich) connection(s) and either executes a
// smart search or (6.4) proposes an add_to_album write, degrading
// gracefully (never throwing) so a connection problem never aborts the chat
// turn: no connection, ambiguity, and adapter failures all resolve to a
// `{ success: false, message }`-shaped payload instead. Reads are read-only;
// add_to_album is the only write action, and — like every connection write
// in this codebase — is proposal-only (see proposeAddToAlbum above). Raw
// photo bytes are never part of this payload: only textual metadata reaches
// the model, and thumbnails are a Sources-UI concern surfaced via
// `candidates[].metadata`.
export async function runPhotosTool(
	userId: string,
	input: PhotosToolInput,
	modelId: string,
	conversationId?: string,
): Promise<PhotosToolOutcome> {
	const connections = await resolveConnectionsForCapability(userId, "photos");
	if (connections.length === 0) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Photos connection set up yet. Connect your Immich account in Settings to search your photos.",
		});
	}

	const ambiguous = needsDisambiguation(connections);
	const conn = connections[0];
	if (!conn) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Photos connection set up yet. Connect your Immich account in Settings to search your photos.",
		});
	}

	// Write action (6.4) branches here — before the read-side query
	// validation below — same posture as calendar.ts's write branching ahead
	// of its shared read flow.
	if (input.action === "add_to_album") {
		return proposeAddToAlbum(
			userId,
			conversationId,
			conn,
			input,
			ambiguous,
			connections,
		);
	}

	if (!input.query) {
		return buildPayload({
			success: false,
			action: "search",
			message: "A search query is required to search your photos.",
		});
	}

	try {
		const photos = await immichSmartSearch(userId, conn.id, {
			query: input.query,
			...(input.limit !== undefined ? { limit: input.limit } : {}),
		});
		const outcome = searchOutcome(conn, photos, ambiguous, connections);
		return applyLocalDistillGate({ userId, modelId, input, outcome });
	} catch (err) {
		return buildPayload({
			success: false,
			action: input.action,
			message: mapAdapterError(err),
		});
	}
}
