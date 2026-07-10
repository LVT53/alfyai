import { z } from "zod";
import {
	groupFixesByPlace,
	haversineDistanceMeters,
	OwnTracksError,
	ownTracksHomeReference,
	owntracksLastLocation,
	owntracksLocationHistory,
	type PlaceVisit,
} from "$lib/server/services/connections/providers/owntracks";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import type { ToolEvidenceCandidate } from "$lib/types";

import { decideLocalDistill } from "./connector-distill";

// Read-only by construction, and NO device/user override: this schema's
// `action` enum only ever lists read actions (last, history, places,
// distance), and there is deliberately no otUser/otDevice/connectionId field
// anywhere in this input — the model can only ever ask "give me MY
// last/history/places/distance location", never "give me user X's device
// Y". The actual device binding is resolved entirely server-side from the
// caller's own connection (see owntracks.ts's
// `owntracksLastLocation`/`owntracksLocationHistory`, which take only
// `(userId, connectionId)`). A dedicated test in location.test.ts pins both
// the enum and the absence of any override field. `lat`/`lon` on this schema
// are a caller-supplied REFERENCE point for the `distance` action (e.g. "how
// far am I from this address") — not a device selector, and not itself a
// location read: it never widens which device/user's data can be reached.
export const locationToolInputSchema = z.object({
	action: z.enum(["last", "history", "places", "distance"]),
	from: z.string().optional(),
	to: z.string().optional(),
	limit: z.number().optional(),
	lat: z.number().optional(),
	lon: z.number().optional(),
});

export type LocationToolInput = z.infer<typeof locationToolInputSchema>;

export function sanitizeLocationToolInput(
	input: LocationToolInput,
): LocationToolInput {
	return {
		action: input.action,
		...(input.from ? { from: input.from.trim() } : {}),
		...(input.to ? { to: input.to.trim() } : {}),
		...(input.limit !== undefined ? { limit: input.limit } : {}),
		...(input.lat !== undefined ? { lat: input.lat } : {}),
		...(input.lon !== undefined ? { lon: input.lon } : {}),
	};
}

export type LocationCitation = { label: string; url: string };

// One location fix as surfaced to the model. `lat`/`lon`/`place` are the
// "raw location details" the locality Option-A distill gate (below) strips
// when active — location is the MOST sensitive data in the whole connections
// feature, so this mirrors photos.ts/media.ts's Option-A shape exactly:
// strip everything that pinpoints where the user is/was, keep only
// structural metadata (`at`, `battery`).
export type LocationToolResultItem = {
	at: string;
	lat?: number;
	lon?: number;
	place?: string;
	battery?: number;
};

// B7 — how the "distance" action reports a computed great-circle distance.
// `mode` records which two points were compared: `reference_point` (current
// fix vs a caller-supplied lat/lon), `home` (current fix vs the connection's
// stored home reference, when one is set), or `range` (first vs last fix of
// a from/to range — "how far did I travel"). Deliberately carries only a
// number and timestamps, never lat/lon or place text, so — unlike
// `results`/`places` — it needs no Option-A redaction: the underlying raw
// fix(es) it was computed from are still surfaced via `results[]`, which the
// existing distill gate already covers.
export type LocationDistanceResult = {
	meters: number;
	kilometers: number;
	fromAt: string;
	toAt?: string;
	mode: "reference_point" | "home" | "range";
};

export type LocationToolModelPayload = {
	success: boolean;
	name: "location";
	sourceType: "tool";
	action: LocationToolInput["action"];
	message: string;
	results: LocationToolResultItem[];
	citations: LocationCitation[];
	// B7 — populated only for the "places" action: a compact places-visited
	// summary (see groupFixesByPlace in owntracks.ts) instead of raw fixes.
	places?: PlaceVisit[];
	// B7 — populated only for the "distance" action.
	distance?: LocationDistanceResult;
};

export type LocationToolOutcome = {
	modelPayload: LocationToolModelPayload;
	candidates: ToolEvidenceCandidate[];
};

type LocationFixLike = {
	lat: number;
	lon: number;
	at: string;
	place?: string;
	battery?: number;
};

function toToolResultItem(fix: LocationFixLike): LocationToolResultItem {
	return {
		at: fix.at,
		lat: fix.lat,
		lon: fix.lon,
		...(fix.place ? { place: fix.place } : {}),
		...(fix.battery !== undefined ? { battery: fix.battery } : {}),
	};
}

function citationLabel(item: LocationToolResultItem): string {
	return item.place ? item.place : `Location at ${item.at}`;
}

// Sources-tab candidate — keeps the real lat/lon (the user's own data on
// their own screen), distinct from the model-facing citation label which
// the Option-A gate below may redact.
function toCandidate(
	fix: LocationFixLike,
	citation: LocationCitation,
): ToolEvidenceCandidate {
	return {
		id: `location:${fix.at}`,
		title: citation.label,
		url: citation.url,
		snippet: citation.label,
		sourceType: "tool",
		metadata: {
			lat: fix.lat,
			lon: fix.lon,
		},
	};
}

function buildPayload(params: {
	success: boolean;
	action: LocationToolInput["action"];
	message: string;
	results?: LocationToolResultItem[];
	citations?: LocationCitation[];
	candidates?: ToolEvidenceCandidate[];
	places?: PlaceVisit[];
	distance?: LocationDistanceResult;
}): LocationToolOutcome {
	const citations = params.citations ?? [];
	return {
		modelPayload: {
			success: params.success,
			name: "location",
			sourceType: "tool",
			action: params.action,
			message: params.message,
			results: params.results ?? [],
			citations,
			...(params.places !== undefined ? { places: params.places } : {}),
			...(params.distance !== undefined ? { distance: params.distance } : {}),
		},
		candidates: params.candidates ?? [],
	};
}

function ambiguityNote(
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	const labels = connections.map((c) => c.label).join(", ");
	return `You have ${connections.length} Location connections (${labels}); using "${conn.label}" for this request.`;
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
	if (err instanceof OwnTracksError) {
		switch (err.code) {
			case "not_configured":
				return "OwnTracks isn't configured on this server. Ask your admin to set it up.";
			default:
				return "I couldn't reach your OwnTracks recorder right now. Please try again in a moment.";
		}
	}
	return "I couldn't reach your location right now. Please try again in a moment.";
}

function lastOutcome(
	conn: ConnectionPublic,
	fix: LocationFixLike | null,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): LocationToolOutcome {
	if (!fix) {
		return buildPayload({
			success: true,
			action: "last",
			message: withAmbiguityPrefix(
				"No location fix is available yet.",
				ambiguous,
				conn,
				connections,
			),
		});
	}
	const item = toToolResultItem(fix);
	const citation: LocationCitation = { label: citationLabel(item), url: "" };
	return buildPayload({
		success: true,
		action: "last",
		message: withAmbiguityPrefix(
			"Found the current location.",
			ambiguous,
			conn,
			connections,
		),
		results: [item],
		citations: [citation],
		candidates: [toCandidate(fix, citation)],
	});
}

function historyOutcome(
	conn: ConnectionPublic,
	fixes: LocationFixLike[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): LocationToolOutcome {
	const items = fixes.map(toToolResultItem);
	const citations: LocationCitation[] = items.map((item) => ({
		label: citationLabel(item),
		url: "",
	}));
	const candidates = fixes.map((fix, index) => {
		const citation = citations[index] as LocationCitation;
		return toCandidate(fix, citation);
	});
	const message =
		items.length === 0
			? "No location history found for that range."
			: `Found ${items.length} location ${items.length === 1 ? "fix" : "fixes"}.`;
	return buildPayload({
		success: true,
		action: "history",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		results: items,
		citations,
		candidates,
	});
}

// B7 — "places": compact "places visited" view over a history range, built
// from groupFixesByPlace (owntracks.ts). This is what actually answers "was
// I at the office yesterday" without the model wading through raw fixes.
function placesOutcome(
	conn: ConnectionPublic,
	visits: PlaceVisit[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): LocationToolOutcome {
	const message =
		visits.length === 0
			? "No location history found for that range."
			: `Visited ${visits.length} distinct place${visits.length === 1 ? "" : "s"}.`;
	return buildPayload({
		success: true,
		action: "places",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		places: visits,
	});
}

function roundKilometers(meters: number): number {
	return Math.round((meters / 1000) * 100) / 100;
}

function distanceMessage(
	mode: LocationDistanceResult["mode"],
	km: number,
): string {
	switch (mode) {
		case "reference_point":
			return `You are approximately ${km} km from the given location.`;
		case "home":
			return `You are approximately ${km} km from home.`;
		case "range":
			return `You traveled approximately ${km} km (straight-line) across that range.`;
	}
}

// B7 — "distance": surfaces the underlying fix(es) via `results[]` (so the
// existing Option-A gate, which scans `results[]` for raw lat/lon, still
// applies) alongside a `distance` summary that itself carries only a number
// and timestamps (see LocationDistanceResult's doc comment).
function distanceOutcome(
	conn: ConnectionPublic,
	fixes: LocationFixLike[],
	meters: number,
	mode: LocationDistanceResult["mode"],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): LocationToolOutcome {
	const items = fixes.map(toToolResultItem);
	const citations: LocationCitation[] = items.map((item) => ({
		label: citationLabel(item),
		url: "",
	}));
	const candidates = fixes.map((fix, index) => {
		const citation = citations[index] as LocationCitation;
		return toCandidate(fix, citation);
	});
	const kilometers = roundKilometers(meters);
	const first = fixes[0];
	const last = fixes[fixes.length - 1];
	const distance: LocationDistanceResult = {
		meters: Math.round(meters),
		kilometers,
		fromAt: first?.at ?? "",
		...(mode === "range" && last ? { toAt: last.at } : {}),
		mode,
	};
	return buildPayload({
		success: true,
		action: "distance",
		message: withAmbiguityPrefix(
			distanceMessage(mode, kilometers),
			ambiguous,
			conn,
			connections,
		),
		results: items,
		citations,
		candidates,
		distance,
	});
}

// Redacts the MODEL-FACING citation labels once Option A distillation has
// applied — same rationale as photos.ts's/media.ts's redactCitationsForModel:
// citations[].label here may carry the real `place` name, which Option A
// strips from `results[]`, so leaving it untouched would let the raw place
// reach the cloud model through `citations` even though `results[].place`
// was stripped two fields earlier in the same payload. `outcome.candidates`
// (the user's own Sources-tab list, built from the *original* unredacted
// fixes before this gate ever runs) is left alone.
function redactCitationsForModel(
	results: LocationToolResultItem[],
	citations: LocationCitation[],
): LocationCitation[] {
	return citations.map((citation, index) => {
		const at = results[index]?.at;
		return {
			...citation,
			label: at ? `Location fix at ${at}` : "Location fix",
		};
	});
}

// Locality Option A: location (lat/lon, place, and by extension the exact
// timestamps they're tied to) is the MOST sensitive data anywhere in the
// connections feature — when the user has opted in to local distillation and
// the selected chat model is cloud, replace it with a summary produced by a
// local model before it reaches the (cloud) model. This strips `lat`/`lon`/
// `place` from every result (leaving only `at`/`battery`, which alone can't
// pinpoint the user), and redacts `citations[].label` (see
// redactCitationsForModel) — i.e. the WHOLE model-facing payload, not just
// one field. `outcome.candidates` (the Sources-tab list) is untouched: it
// feeds the user's own screen, a different channel from what the model
// sees, and keeps the real coordinates so a map can still render.
async function applyLocalDistillGate(params: {
	userId: string;
	modelId: string;
	input: LocationToolInput;
	outcome: LocationToolOutcome;
}): Promise<LocationToolOutcome> {
	const { userId, modelId, input, outcome } = params;
	if (!outcome.modelPayload.success) return outcome;

	const rawTextParts = [
		...outcome.modelPayload.results
			.map((item) => {
				if (item.lat === undefined || item.lon === undefined) return null;
				const place = item.place ? ` (${item.place})` : "";
				return `${item.lat}, ${item.lon}${place} at ${item.at}`;
			})
			.filter((value): value is string => Boolean(value)),
		// B7 — the "places" action's `places[]` carries place-name text too
		// (no lat/lon, but the label itself is exactly the sensitive detail
		// Option A exists to protect), so it must feed the same gate.
		...(outcome.modelPayload.places ?? []).map(
			(visit) => `${visit.place} from ${visit.from} to ${visit.to}`,
		),
	];
	// Nothing raw to protect (e.g. a "no fix available" result with no
	// lat/lon at all, and no places[]) — the gate is a no-op.
	if (rawTextParts.length === 0) return outcome;

	const decision = await decideLocalDistill({
		userId,
		modelId,
		capability: "location",
		userQuestion: input.action,
		rawText: rawTextParts.join("\n"),
	});
	if (!decision.shouldDistill) return outcome;

	const strippedResults = outcome.modelPayload.results.map((item) => {
		const { lat: _lat, lon: _lon, place: _place, ...rest } = item;
		return rest;
	});
	// Redact only the MODEL-facing copy — `outcome.candidates` (the
	// user-facing Sources-tab list) was already built from the original,
	// unredacted fixes and is untouched by this gate.
	const redactedCitations = redactCitationsForModel(
		outcome.modelPayload.results,
		outcome.modelPayload.citations,
	);
	// B7 — `places[].place` is raw place-name text, exactly what this gate
	// exists to protect; the distilled summary (in `message`) replaces it, so
	// the structured list is fully cleared rather than partially redacted
	// (there's nothing non-sensitive left worth keeping per visit once the
	// place name is gone).
	const strippedPlaces = outcome.modelPayload.places ? [] : undefined;

	if ("distilled" in decision) {
		return {
			...outcome,
			modelPayload: {
				...outcome.modelPayload,
				message: `${outcome.modelPayload.message} Privately summarized for a cloud model. Summary: ${decision.distilled}`,
				results: strippedResults,
				citations: redactedCitations,
				...(strippedPlaces !== undefined ? { places: strippedPlaces } : {}),
			},
		};
	}

	return {
		...outcome,
		modelPayload: {
			...outcome.modelPayload,
			message:
				"This location couldn't be privately summarized for a cloud model, so it was withheld. Switch to a local model to view it, or try again.",
			results: strippedResults,
			citations: redactedCitations,
			...(strippedPlaces !== undefined ? { places: strippedPlaces } : {}),
		},
	};
}

// Resolves the user's Location (OwnTracks) connection(s) and executes a
// last/history lookup, degrading gracefully (never throwing) so a connection
// problem never aborts the chat turn: no connection, ambiguity, and adapter
// failures all resolve to a `{ success: false, message }`-shaped payload
// instead. Read-only — there is no write action in locationToolInputSchema
// and never will be. The device binding itself is never influenced by this
// function's inputs: `owntracksLastLocation`/`owntracksLocationHistory` take
// only `(userId, connectionId)` and resolve otUser/otDevice from the stored
// connection config, so there is no path — here or in the schema above —
// through which a model-supplied argument could redirect a read to a
// different device or user.
export async function runLocationTool(
	userId: string,
	input: LocationToolInput,
	modelId: string,
): Promise<LocationToolOutcome> {
	const connections = await resolveConnectionsForCapability(userId, "location");
	if (connections.length === 0) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Location connection set up yet. Connect your OwnTracks device in Settings to check your location.",
		});
	}

	const ambiguous = needsDisambiguation(connections);
	const conn = connections[0];
	if (!conn) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Location connection set up yet. Connect your OwnTracks device in Settings to check your location.",
		});
	}

	try {
		if (input.action === "history") {
			const fixes = await owntracksLocationHistory(userId, conn.id, {
				...(input.from !== undefined ? { from: input.from } : {}),
				...(input.to !== undefined ? { to: input.to } : {}),
				...(input.limit !== undefined ? { limit: input.limit } : {}),
			});
			const outcome = historyOutcome(conn, fixes, ambiguous, connections);
			return applyLocalDistillGate({ userId, modelId, input, outcome });
		}

		// B7 — "places": same underlying history fetch as "history", but
		// collapsed into a compact places-visited summary (see
		// groupFixesByPlace's doc comment in owntracks.ts).
		if (input.action === "places") {
			const fixes = await owntracksLocationHistory(userId, conn.id, {
				...(input.from !== undefined ? { from: input.from } : {}),
				...(input.to !== undefined ? { to: input.to } : {}),
				...(input.limit !== undefined ? { limit: input.limit } : {}),
			});
			const visits = groupFixesByPlace(fixes);
			const outcome = placesOutcome(conn, visits, ambiguous, connections);
			return applyLocalDistillGate({ userId, modelId, input, outcome });
		}

		// B7 — "distance": three mutually exclusive modes, checked in this
		// order — (1) a caller-supplied reference point ("how far is X from
		// Y" given coords), (2) a from/to range ("how far did I travel"),
		// (3) falling back to the connection's stored home reference ("how
		// far am I from home"). The home-reference check happens BEFORE any
		// recorder call so a device with no home set never needlessly hits
		// the recorder for a question this module can't answer anyway.
		if (input.action === "distance") {
			if (input.lat !== undefined && input.lon !== undefined) {
				const fix = await owntracksLastLocation(userId, conn.id);
				if (!fix) {
					return buildPayload({
						success: true,
						action: "distance",
						message: withAmbiguityPrefix(
							"No location fix is available yet.",
							ambiguous,
							conn,
							connections,
						),
					});
				}
				const meters = haversineDistanceMeters(fix, {
					lat: input.lat,
					lon: input.lon,
				});
				const outcome = distanceOutcome(
					conn,
					[fix],
					meters,
					"reference_point",
					ambiguous,
					connections,
				);
				return applyLocalDistillGate({ userId, modelId, input, outcome });
			}

			if (input.from !== undefined || input.to !== undefined) {
				const fixes = await owntracksLocationHistory(userId, conn.id, {
					...(input.from !== undefined ? { from: input.from } : {}),
					...(input.to !== undefined ? { to: input.to } : {}),
					...(input.limit !== undefined ? { limit: input.limit } : {}),
				});
				if (fixes.length < 2) {
					const outcome = buildPayload({
						success: true,
						action: "distance",
						message: withAmbiguityPrefix(
							"Not enough location history in that range to calculate distance.",
							ambiguous,
							conn,
							connections,
						),
						results: fixes.map(toToolResultItem),
					});
					return applyLocalDistillGate({ userId, modelId, input, outcome });
				}
				const first = fixes[0] as LocationFixLike;
				const last = fixes[fixes.length - 1] as LocationFixLike;
				const meters = haversineDistanceMeters(first, last);
				const outcome = distanceOutcome(
					conn,
					[first, last],
					meters,
					"range",
					ambiguous,
					connections,
				);
				return applyLocalDistillGate({ userId, modelId, input, outcome });
			}

			const home = ownTracksHomeReference(conn);
			if (!home) {
				return buildPayload({
					success: true,
					action: "distance",
					message: withAmbiguityPrefix(
						"You don't have a home location saved for this device, so I can't calculate the distance to home.",
						ambiguous,
						conn,
						connections,
					),
				});
			}
			const fix = await owntracksLastLocation(userId, conn.id);
			if (!fix) {
				return buildPayload({
					success: true,
					action: "distance",
					message: withAmbiguityPrefix(
						"No location fix is available yet.",
						ambiguous,
						conn,
						connections,
					),
				});
			}
			const meters = haversineDistanceMeters(fix, home);
			const outcome = distanceOutcome(
				conn,
				[fix],
				meters,
				"home",
				ambiguous,
				connections,
			);
			return applyLocalDistillGate({ userId, modelId, input, outcome });
		}

		const fix = await owntracksLastLocation(userId, conn.id);
		const outcome = lastOutcome(conn, fix, ambiguous, connections);
		return applyLocalDistillGate({ userId, modelId, input, outcome });
	} catch (err) {
		return buildPayload({
			success: false,
			action: input.action,
			message: mapAdapterError(err),
		});
	}
}
