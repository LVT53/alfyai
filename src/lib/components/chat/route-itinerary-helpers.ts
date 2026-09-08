// Pure helpers for RouteItinerary.svelte, kept in a .ts module so tests
// and other components can import them by name.
import type { ToolCallMapManeuver } from "$lib/server/services/messages-types";

// A span of the drawn polyline — [firstIndex, lastIndex] — which is how a
// step or a leg tells the map which stretch to highlight.
export type ItineraryRange = [number, number];

// The vehicle a timeline row is riding, in the words the card draws icons
// for. Derived from GTFS route_type upstream (`vehicle`), or from the leg's
// own mode on a self-powered leg.
export type ItineraryGlyph =
	| "car"
	| "walk"
	| "bike"
	| "train"
	| "bus"
	| "tram"
	| "metro"
	| "ferry"
	| "change";

// GTFS gives a plain word for the vehicle; the card has an icon for a few of
// them and falls back to the train glyph for the rest of the rail family and
// the bus glyph for road services.
export function glyphForVehicle(vehicle: string | undefined): ItineraryGlyph {
	switch (vehicle) {
		case "tram":
			return "tram";
		case "metro":
			return "metro";
		case "bus":
		case "coach":
		case "trolleybus":
			return "bus";
		case "ferry":
			return "ferry";
		default:
			return "train";
	}
}

// One colour per line, stable across renders and across conversations: the
// same tram line is always the same colour, and two lines in one journey are
// almost never the same. A feed that publishes its own `route_color` wins —
// people recognise their city's line colours, and inventing a different one
// would be worse than useless.
//
// The palette is picked per vehicle family (rail blues, road greens, tram and
// metro warms) and then indexed by a hash of the line name, so the choice is
// deterministic rather than order-dependent.
const LINE_PALETTES: Record<string, string[]> = {
	train: ["#1f4e9c", "#2a5fb0", "#17406f"],
	metro: ["#7a3ea1", "#8f4fb8", "#5f2f80"],
	tram: ["#c15f3c", "#a94e2f", "#d1734f"],
	bus: ["#2f7d4f", "#15803d", "#3f9160"],
	ferry: ["#0f766e", "#128078", "#0c5f59"],
	walk: ["#6b6b6b"],
	change: ["#6b6b6b"],
	bike: ["#15803d"],
	car: ["#4a4a4a"],
};

export function itineraryLineColor(
	glyph: ItineraryGlyph,
	line: string | undefined,
	feedColor?: string,
): string {
	// A feed colour arrives as GTFS writes it — six hex digits, no "#".
	if (feedColor) {
		const clean = feedColor.trim().replace(/^#/, "");
		if (/^[0-9a-fA-F]{6}$/.test(clean)) return `#${clean}`;
	}
	const palette = LINE_PALETTES[glyph] ?? LINE_PALETTES.train;
	if (palette.length === 1) return palette[0];
	let hash = 0;
	for (const char of line ?? "") {
		hash = (hash * 31 + char.charCodeAt(0)) % 100_000;
	}
	return palette[hash % palette.length];
}

// The manoeuvre icons the Directions list draws, keyed by the vocabulary the
// server maps ORS's numeric codes onto. Several manoeuvres share a glyph
// (a slight left and a sharp left are both "left-ish"), which is deliberate:
// a distinct arrow per code would be noise at 14px.
export function maneuverGlyph(
	maneuver: ToolCallMapManeuver,
): "straight" | "left" | "right" | "roundabout" | "flag" {
	switch (maneuver) {
		case "left":
		case "slight-left":
		case "sharp-left":
		case "keep-left":
		case "u-turn":
			return "left";
		case "right":
		case "slight-right":
		case "sharp-right":
		case "keep-right":
			return "right";
		case "roundabout":
		case "exit-roundabout":
			return "roundabout";
		case "arrive":
			return "flag";
		default:
			return "straight";
	}
}
