// Turn-by-turn directions: the compaction layer between what ORS returns for
// a road route (`RouteData.legs[].steps[]`, one entry per manoeuvre, with the
// engine's numeric instruction code) and what the chat card persists and
// draws (`ToolCallMapStep`, an icon name plus one line of text).
//
// Everything here is pure and deliberately small, because the output is
// PERSISTED on the tool-call entry: a route card rides in the conversation
// row forever, so a hundred-step motorway route must not turn into a hundred
// kilobytes of JSON. Hence the caps below — they are the whole reason this
// module exists rather than the raw steps being passed through.

import type {
	ToolCallMapManeuver,
	ToolCallMapStep,
} from "$lib/server/services/messages-types";
import type { RouteData, RouteStep } from "./types";

// A long route's step list is the card's biggest variable cost. 60 manoeuvres
// is far more than anyone reads in a chat card and still covers a normal
// cross-country drive; beyond it the list is trimmed (keeping the arrival —
// see capSteps) rather than the card refusing to persist.
export const MAX_CARD_STEPS = 60;
// ORS instructions are one short sentence; 120 characters keeps even the
// wordiest roundabout instruction whole and bounds the pathological case.
export const MAX_INSTRUCTION_CHARS = 120;

// ORS `segments[].steps[].type` → the card's manoeuvre vocabulary. The codes
// are fixed by openrouteservice (InstructionType: 0 LEFT, 1 RIGHT, 2 SHARP
// LEFT, 3 SHARP RIGHT, 4 SLIGHT LEFT, 5 SLIGHT RIGHT, 6 STRAIGHT, 7 ENTER
// ROUNDABOUT, 8 EXIT ROUNDABOUT, 9 U-TURN, 10 GOAL, 11 DEPART, 12 KEEP LEFT,
// 13 KEEP RIGHT), so this table is a transcription, not a guess.
//
// "merge" is in the vocabulary (the icon set draws it) but ORS has no code
// for it; a provider that does can map onto it without a UI change.
const ORS_MANEUVER_BY_TYPE: Record<number, ToolCallMapManeuver> = {
	0: "left",
	1: "right",
	2: "sharp-left",
	3: "sharp-right",
	4: "slight-left",
	5: "slight-right",
	6: "straight",
	7: "roundabout",
	8: "exit-roundabout",
	9: "u-turn",
	10: "arrive",
	11: "depart",
	12: "keep-left",
	13: "keep-right",
};

export function maneuverFromOrsType(
	type: number | undefined,
): ToolCallMapManeuver {
	if (type === undefined) return "other";
	return ORS_MANEUVER_BY_TYPE[type] ?? "other";
}

// ORS writes "-" for a stretch of road with no name; that is not a subtext.
function roadName(step: RouteStep): string | undefined {
	const name = step.name?.trim();
	if (!name || name === "-") return undefined;
	return name;
}

function trimInstruction(text: string): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= MAX_INSTRUCTION_CHARS) return clean;
	return `${clean.slice(0, MAX_INSTRUCTION_CHARS - 1).trimEnd()}…`;
}

// Keeps the list under the cap WITHOUT losing the arrival: a route trimmed to
// its first 60 manoeuvres would end mid-motorway, which reads as a bug. The
// last step is always the destination, so it is kept and the middle is what
// goes.
export function capSteps(steps: ToolCallMapStep[]): ToolCallMapStep[] {
	if (steps.length <= MAX_CARD_STEPS) return steps;
	return [
		...steps.slice(0, MAX_CARD_STEPS - 1),
		steps[steps.length - 1] as ToolCallMapStep,
	];
}

// Flattens a route's legs into ONE compact manoeuvre list for the card.
// A step with no instruction text at all is dropped — an icon and a distance
// with nothing to read is noise, not a direction.
export function buildRouteSteps(route: RouteData): ToolCallMapStep[] {
	const steps: ToolCallMapStep[] = [];
	for (const leg of route.legs ?? []) {
		for (const raw of leg.steps ?? []) {
			const instruction = trimInstruction(raw.instruction ?? "");
			if (!instruction) continue;
			const name = roadName(raw);
			const step: ToolCallMapStep = {
				instruction,
				maneuver: maneuverFromOrsType(raw.type),
				distanceM: Math.round(raw.distance_m),
				durationS: Math.round(raw.duration_s),
			};
			// The road name is subtext only when the instruction does not
			// already say it — "Turn left onto R600" plus a "R600" subtext is
			// the same word twice.
			if (name && !instruction.includes(name)) step.name = name;
			if (raw.way_points) {
				step.wayPointRange = [raw.way_points[0], raw.way_points[1]];
			}
			steps.push(step);
		}
	}
	return capSteps(steps);
}

// The road the route mostly follows — the summary line's "via R600". Picked
// by total distance travelled on each named road, so a long motorway stretch
// wins over the six turns it took to reach it.
export function routeVia(route: RouteData): string | undefined {
	const byName = new Map<string, number>();
	for (const leg of route.legs ?? []) {
		for (const step of leg.steps ?? []) {
			const name = roadName(step);
			if (!name) continue;
			byName.set(name, (byName.get(name) ?? 0) + step.distance_m);
		}
	}
	let best: string | undefined;
	let bestDistance = 0;
	for (const [name, distance] of byName) {
		if (distance > bestDistance) {
			best = name;
			bestDistance = distance;
		}
	}
	return best;
}

// The model-facing shape of a step: text, not structure. The card already
// draws the full list, so what the model needs is enough to describe the
// shape of the drive in a sentence — never to recite it turn by turn.
export type StepNarration = {
	instruction: string;
	distance: string;
};

function formatDistance(meters: number): string {
	if (meters < 1000) return `${Math.round(meters)} m`;
	return `${(meters / 1000).toFixed(1)} km`;
}

// The narration list is capped harder than the card's: a dozen lines is
// plenty of context for one summarising paragraph, and every extra line is
// prompt cost on every later turn that replays the tool result.
export const MAX_NARRATION_STEPS = 12;

export function narrateSteps(steps: ToolCallMapStep[]): StepNarration[] {
	const source =
		steps.length <= MAX_NARRATION_STEPS
			? steps
			: [
					...steps.slice(0, MAX_NARRATION_STEPS - 1),
					steps[steps.length - 1] as ToolCallMapStep,
				];
	return source.map((step) => ({
		instruction: step.instruction,
		distance: formatDistance(step.distanceM),
	}));
}
