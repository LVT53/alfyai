import { z } from "zod";
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
import type { ToolEvidenceCandidate } from "$lib/types";

import { decideLocalDistill } from "./connector-distill";

export const photosToolInputSchema = z.object({
	action: z.enum(["search"]),
	query: z.string(),
	limit: z.number().optional(),
});

export type PhotosToolInput = z.infer<typeof photosToolInputSchema>;

export function sanitizePhotosToolInput(
	input: PhotosToolInput,
): PhotosToolInput {
	return {
		action: input.action,
		query: input.query.trim(),
		...(input.limit !== undefined ? { limit: input.limit } : {}),
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
		userQuestion: input.query,
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

// Resolves the user's Photos (Immich) connection(s) and executes a smart
// search, degrading gracefully (never throwing) so a connection problem
// never aborts the chat turn: no connection, ambiguity, and adapter failures
// all resolve to a `{ success: false, message }`-shaped payload instead.
// Read-only — writes are out of scope (Phase 6.4). Raw photo bytes are never
// part of this payload: only textual metadata reaches the model, and
// thumbnails are a Sources-UI concern surfaced via `candidates[].metadata`.
export async function runPhotosTool(
	userId: string,
	input: PhotosToolInput,
	modelId: string,
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
