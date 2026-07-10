import { z } from "zod";
import { createPendingWrite } from "$lib/server/services/connections/pending-writes";
import {
	type ImmichAlbumSummary,
	ImmichError,
	type ImmichPersonSummary,
	immichAlbumAssets,
	immichListAlbums,
	immichListPeople,
	immichMetadataSearch,
	immichSmartSearch,
	type MetadataSearchParams,
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
	action: z.enum([
		"search",
		"search_by_date",
		"list_albums",
		"album",
		"list_people",
		"add_to_album",
	]),
	query: z.string().optional(),
	limit: z.number().optional(),
	// B1 metadata-search filters. `from`/`to` bound the capture date and accept
	// either a full ISO datetime or a bare "YYYY-MM-DD" (normalized adapter-side).
	from: z.string().optional(),
	to: z.string().optional(),
	city: z.string().optional(),
	country: z.string().optional(),
	type: z.enum(["IMAGE", "VIDEO"]).optional(),
	favorites: z.boolean().optional(),
	// B6 — a person's name; the tool resolves it to personIds via list_people
	// before filtering the metadata search.
	personName: z.string().optional(),
	// B1 album browse — the id from list_albums whose assets to fetch.
	albumId: z.string().optional(),
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
		...(input.from !== undefined ? { from: input.from.trim() } : {}),
		...(input.to !== undefined ? { to: input.to.trim() } : {}),
		...(input.city !== undefined ? { city: input.city.trim() } : {}),
		...(input.country !== undefined ? { country: input.country.trim() } : {}),
		...(input.type !== undefined ? { type: input.type } : {}),
		...(input.favorites !== undefined ? { favorites: input.favorites } : {}),
		...(input.personName !== undefined
			? { personName: input.personName.trim() }
			: {}),
		...(input.albumId !== undefined ? { albumId: input.albumId.trim() } : {}),
		...(input.assetIds !== undefined
			? { assetIds: input.assetIds.map((id) => id.trim()).filter(Boolean) }
			: {}),
	};
}

export type PhotoCitation = { label: string; url: string };

// One photo as surfaced to the model. `place`/`description` are the "raw
// photo details" the locality Option-A distill gate (below) strips when
// active — mirrors calendar.ts keeping id/start/end while stripping summary/
// location. `id`/`takenAt`/`type` are structural metadata, never stripped.
// `fileName` is also treated as raw (unlike, say, the files tool's filename)
// because an Immich original filename routinely embeds a date/location/event
// name (e.g. "hospital-visit.jpg") — see the issue's Option-A test.
// No `people` field: PhotoResult never carries one — Immich's smart-search
// endpoint has no withPeople parameter and never joins faces (see immich.ts).
export type PhotoToolResultItem = {
	id: string;
	fileName?: string;
	takenAt: string;
	type: "IMAGE" | "VIDEO";
	place?: string;
	description?: string;
	// A renderable image URL the model can embed directly as markdown
	// (`![caption](imageUrl)`) to SHOW the photo, not just describe it. Points
	// at the AUTHED per-user app proxy (Task 11a,
	// /api/connections/immich/thumbnail/[assetId]) — never the raw Immich
	// path (that's `PhotoResult.thumbnailPath`, candidates-only, see
	// toCandidate below). Structural, like `id`/`takenAt`: it's derived from
	// `id` alone and carries no photo bytes, so it is intentionally NOT
	// stripped by the locality Option-A distill gate below — see that gate's
	// comment for the full reasoning.
	imageUrl: string;
};

// Album/person discovery items (B1 list_albums / B6 list_people). Like
// calendar.ts's list_calendars, these surface names the model needs to drill
// in (an albumId for `album`, a personName for `search_by_date`). They are
// discovery metadata, not photo-content reads, so — matching list_calendars —
// they are NOT run through the Option-A distill gate.
export type PhotoAlbumItem = { id: string; name: string; assetCount: number };
export type PhotoPersonItem = { id: string; name: string };

export type PhotosToolModelPayload = {
	success: boolean;
	name: "photos";
	sourceType: "tool";
	action: PhotosToolInput["action"];
	message: string;
	results: PhotoToolResultItem[];
	citations: PhotoCitation[];
	// Only set by list_albums / list_people respectively.
	albums?: PhotoAlbumItem[];
	people?: PhotoPersonItem[];
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

// The AUTHED per-user app proxy path (Task 11a) — NOT the raw Immich path
// (`photo.thumbnailPath`, e.g. "/api/assets/{id}/thumbnail"). The proxy
// resolves the caller's own connection/vault key server-side, so this is
// safe to hand to the model as a plain relative URL string: only the id is
// disclosed, never a credential, and the client (not the model) is what
// actually fetches the bytes when it renders the markdown image.
function thumbnailProxyUrl(assetId: string): string {
	return `/api/connections/immich/thumbnail/${assetId}`;
}

function toToolResultItem(photo: PhotoResult): PhotoToolResultItem {
	return {
		id: photo.id,
		fileName: photo.fileName,
		takenAt: photo.takenAt,
		type: photo.type,
		...(photo.place ? { place: photo.place } : {}),
		...(photo.description ? { description: photo.description } : {}),
		imageUrl: thumbnailProxyUrl(photo.id),
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
	albums?: PhotoAlbumItem[];
	people?: PhotoPersonItem[];
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
			...(params.albums ? { albums: params.albums } : {}),
			...(params.people ? { people: params.people } : {}),
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

// Shared by every action that returns PhotoResult[] (search / search_by_date /
// album). `action` is threaded through so the payload reports which read
// produced the results.
function searchOutcome(
	conn: ConnectionPublic,
	photos: PhotoResult[],
	action: "search" | "search_by_date" | "album",
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
		action,
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		results: items,
		citations,
		candidates,
	});
}

function listAlbumsOutcome(
	conn: ConnectionPublic,
	albums: ImmichAlbumSummary[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): PhotosToolOutcome {
	const items: PhotoAlbumItem[] = albums.map((album) => ({
		id: album.id,
		name: album.albumName,
		assetCount: album.assetCount,
	}));
	const message =
		items.length === 0
			? "You don't have any albums yet."
			: `Found ${items.length} ${items.length === 1 ? "album" : "albums"}. Pass an album's id as albumId to the "album" action to see its photos.`;
	return buildPayload({
		success: true,
		action: "list_albums",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		albums: items,
	});
}

function listPeopleOutcome(
	conn: ConnectionPublic,
	people: ImmichPersonSummary[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): PhotosToolOutcome {
	const items: PhotoPersonItem[] = people.map((person) => ({
		id: person.id,
		name: person.name,
	}));
	const message =
		items.length === 0
			? "I couldn't find any named people in your photos."
			: `Found ${items.length} named ${items.length === 1 ? "person" : "people"}. Pass a name as personName to search_by_date to find their photos.`;
	return buildPayload({
		success: true,
		action: "list_people",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		people: items,
	});
}

// Case-insensitive name match used to resolve a personName filter to
// personIds. Matches exact names first; if none, falls back to substring
// matches so a first name ("alice") still finds "Alice Smith".
function matchPeopleByName(
	people: ImmichPersonSummary[],
	name: string,
): ImmichPersonSummary[] {
	const needle = name.trim().toLowerCase();
	if (!needle) return [];
	const exact = people.filter((p) => p.name.toLowerCase() === needle);
	if (exact.length > 0) return exact;
	return people.filter((p) => p.name.toLowerCase().includes(needle));
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

// Locality Option A: photo metadata (filenames, places, descriptions) is
// sensitive personal data — when the user has opted in to local distillation
// and the selected chat model is cloud, replace it with a summary produced
// by a local model before it reaches the (cloud) model. This strips
// `fileName`/`place`/`description` from every result, and redacts
// `citations[].label` (see redactCitationsForModel) — i.e. the WHOLE
// model-facing payload, not just one field. `outcome.candidates` (the
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
			if (descriptors.length === 0) return null;
			return `${descriptors.join(" — ")} (${item.takenAt})`;
		})
		.filter((value): value is string => Boolean(value));
	// Nothing raw to protect (e.g. every result is bare metadata with no
	// filename/place/description) — the gate is a no-op.
	if (rawTextParts.length === 0) return outcome;

	const decision = await decideLocalDistill({
		userId,
		modelId,
		capability: "photos",
		userQuestion: input.query ?? "",
		rawText: rawTextParts.join("\n"),
	});
	if (!decision.shouldDistill) return outcome;

	// `imageUrl` is deliberately NOT destructured out here, unlike
	// fileName/place/description — it survives the gate alongside `id`/
	// `takenAt`/`type`. Rationale: imageUrl is derived purely from
	// `results[].id` (see thumbnailProxyUrl above), a value this gate already
	// treats as structural and preserves; it adds no new information beyond
	// that id. It also carries no photo BYTES — it's a same-origin URL to the
	// authed per-user proxy (`/api/connections/immich/thumbnail/{id}`), which
	// the *client* fetches when it renders the model's markdown image, using
	// the caller's own session, never the model. So keeping imageUrl lets the
	// model still SHOW a distilled photo (with a generic/takenAt caption)
	// even when fileName/place/description have been withheld from it.
	const strippedResults = outcome.modelPayload.results.map((item) => {
		const {
			fileName: _fileName,
			place: _place,
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

	// Discovery browse actions (B1 list_albums / B6 list_people). Like
	// calendar.ts's list_calendars, these are inside their own try so an
	// adapter failure degrades to a graceful note, and — being discovery
	// metadata, not photo-content reads — they never run through the
	// Option-A distill gate.
	if (input.action === "list_albums") {
		try {
			const albums = await immichListAlbums(userId, conn.id);
			return listAlbumsOutcome(conn, albums, ambiguous, connections);
		} catch (err) {
			return buildPayload({
				success: false,
				action: input.action,
				message: mapAdapterError(err),
			});
		}
	}

	if (input.action === "list_people") {
		try {
			const people = await immichListPeople(userId, conn.id);
			return listPeopleOutcome(conn, people, ambiguous, connections);
		} catch (err) {
			return buildPayload({
				success: false,
				action: input.action,
				message: mapAdapterError(err),
			});
		}
	}

	// Album assets (B1) — a photo-content read, so it goes through the
	// Option-A distill gate like search does.
	if (input.action === "album") {
		if (!input.albumId) {
			return buildPayload({
				success: false,
				action: "album",
				message: "An albumId is required — call list_albums first to find it.",
			});
		}
		try {
			const photos = await immichAlbumAssets(userId, conn.id, {
				albumId: input.albumId,
				...(input.limit !== undefined ? { limit: input.limit } : {}),
			});
			const outcome = searchOutcome(
				conn,
				photos,
				"album",
				ambiguous,
				connections,
			);
			return applyLocalDistillGate({ userId, modelId, input, outcome });
		} catch (err) {
			return buildPayload({
				success: false,
				action: input.action,
				message: mapAdapterError(err),
			});
		}
	}

	// Metadata / date-range / person search (B1 + B6). A photo-content read,
	// so it goes through the Option-A distill gate.
	if (input.action === "search_by_date") {
		try {
			let personIds: string[] | undefined;
			if (input.personName) {
				const people = await immichListPeople(userId, conn.id);
				const matches = matchPeopleByName(people, input.personName);
				if (matches.length === 0) {
					return buildPayload({
						success: false,
						action: "search_by_date",
						message: withAmbiguityPrefix(
							`I couldn't find anyone named "${input.personName}" in your photos. Use list_people to see the names Immich has.`,
							ambiguous,
							conn,
							connections,
						),
					});
				}
				personIds = matches.map((p) => p.id);
			}

			const searchParams: MetadataSearchParams = {
				...(input.from ? { takenAfter: input.from } : {}),
				...(input.to ? { takenBefore: input.to } : {}),
				...(input.city ? { city: input.city } : {}),
				...(input.country ? { country: input.country } : {}),
				...(input.type ? { type: input.type } : {}),
				...(input.favorites !== undefined
					? { isFavorite: input.favorites }
					: {}),
				...(personIds ? { personIds } : {}),
				...(input.limit !== undefined ? { limit: input.limit } : {}),
			};
			const photos = await immichMetadataSearch(userId, conn.id, searchParams);
			const outcome = searchOutcome(
				conn,
				photos,
				"search_by_date",
				ambiguous,
				connections,
			);
			return applyLocalDistillGate({ userId, modelId, input, outcome });
		} catch (err) {
			return buildPayload({
				success: false,
				action: input.action,
				message: mapAdapterError(err),
			});
		}
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
		const outcome = searchOutcome(
			conn,
			photos,
			"search",
			ambiguous,
			connections,
		);
		return applyLocalDistillGate({ userId, modelId, input, outcome });
	} catch (err) {
		return buildPayload({
			success: false,
			action: input.action,
			message: mapAdapterError(err),
		});
	}
}
