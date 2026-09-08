// Mixed-mode journeys — "cycle to the station, take the train, walk to the
// college" planned as ONE trip rather than three unrelated tool calls.
//
// Two things make this more than a loop over the existing actions:
//
//  1. CHAINING. The model names the modes in order and only the places where
//     they change; a leg without `from`/`to` inherits the previous leg's end
//     and the next leg's start (see chainJourneyLegs), so the common case is
//     one line of input.
//
//  2. BACKWARDS PLANNING. "Be there by 11" is answered by planning the LAST
//     leg first against the deadline and walking backwards, each earlier leg
//     arriving a transfer buffer before the next one leaves. Planning forwards
//     from a guessed departure and hoping to land on time is exactly the kind
//     of fabrication this tool family refuses to do.
//
// All clock arithmetic here is on ORS's own LOCAL date-time shape
// ("YYYY-MM-DDTHH:mm:ss", no offset) — the same string the transit provider
// takes and the same one it is told back. Nothing here invents a timezone: a
// transit leg's real times come from the provider's answer, converted with the
// region's timezone it reports alongside them.

import { formatLocalDateTime } from "./gtfs-feeds";
import type {
	LatLng,
	PlaceInput,
	RouteData,
	RoutingMode,
	RoutingProvider,
	TransitItinerary,
} from "./types";

export type JourneyLegMode = RoutingMode | "transit";

// One leg as the model writes it.
export type JourneyLegInput = {
	mode: JourneyLegMode;
	from?: PlaceInput;
	to?: PlaceInput;
};

// The same leg once the chain is closed: both ends are known.
export type ChainedJourneyLeg = {
	mode: JourneyLegMode;
	from: PlaceInput;
	to: PlaceInput;
};

export type ChainOutcome =
	| { ok: true; legs: ChainedJourneyLeg[] }
	| { ok: false; message: string };

/**
 * Closes the chain: consecutive legs share an endpoint, so the `to` of one is
 * the `from` of the next. The journey's `origin` opens the first leg and its
 * `destination` closes the last.
 *
 * A leg whose start is still unknown after that (the model named a middle
 * place on neither side) is an error, not a guess — a journey with a hole in
 * it would otherwise be routed between the wrong two points.
 */
export function chainJourneyLegs(
	legs: JourneyLegInput[],
	origin: PlaceInput,
	destination: PlaceInput,
): ChainOutcome {
	if (legs.length === 0) {
		return { ok: false, message: "journey requires at least one leg." };
	}
	const starts: (PlaceInput | undefined)[] = legs.map((leg) => leg.from);
	const ends: (PlaceInput | undefined)[] = legs.map((leg) => leg.to);
	starts[0] = starts[0] ?? origin;
	ends[ends.length - 1] = ends[ends.length - 1] ?? destination;

	// Two passes: forwards fills a missing start from the previous end,
	// backwards fills a missing end from the next start. Either direction alone
	// leaves half the holes open when the model names only one side.
	for (let i = 1; i < legs.length; i++) {
		starts[i] = starts[i] ?? ends[i - 1];
	}
	for (let i = legs.length - 2; i >= 0; i--) {
		ends[i] = ends[i] ?? starts[i + 1];
	}
	// The forward pass may now be satisfiable where it was not before (a hole
	// filled from the right), so run it once more.
	for (let i = 1; i < legs.length; i++) {
		starts[i] = starts[i] ?? ends[i - 1];
	}

	const chained: ChainedJourneyLeg[] = [];
	for (let i = 0; i < legs.length; i++) {
		const from = starts[i];
		const to = ends[i];
		if (from === undefined || to === undefined) {
			return {
				ok: false,
				message: `journey leg ${i + 1} (${legs[i].mode}) has no ${from === undefined ? "start" : "end"}. Give that leg a \`from\`/\`to\`, or name the place on the neighbouring leg.`,
			};
		}
		chained.push({ mode: legs[i].mode, from, to });
	}
	return { ok: true, legs: chained };
}

// ── Local date-time arithmetic ─────────────────────────────────

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

// Minutes since an arbitrary epoch for a LOCAL date-time. Parsed through
// Date.UTC so the machine's own timezone never enters the arithmetic — these
// are wall-clock minutes in the journey's own region, nothing more.
export function localToMinutes(local: string): number | null {
	const match = LOCAL_RE.exec(local.trim());
	if (!match) return null;
	const [, year, month, day, hour, minute] = match;
	const ms = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
	);
	return Math.round(ms / 60_000);
}

export function minutesToLocal(minutes: number): string {
	const date = new Date(minutes * 60_000);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00`;
}

export function shiftLocal(local: string, deltaMinutes: number): string {
	const minutes = localToMinutes(local);
	if (minutes === null) return local;
	return minutesToLocal(minutes + deltaMinutes);
}

// ── Transfer buffers ───────────────────────────────────────────

// Time left between arriving on one leg and the next one leaving. Five minutes
// is the ordinary allowance; a bike leg that ends at a service needs longer,
// because the bike has to be parked and locked before the platform.
export const DEFAULT_TRANSFER_BUFFER_MINUTES = 5;
export const BIKE_TO_TRANSIT_BUFFER_MINUTES = 7;

export function transferBufferMinutes(
	arriving: JourneyLegMode,
	departing: JourneyLegMode,
): number {
	if (arriving === "bike" && departing === "transit") {
		return BIKE_TO_TRANSIT_BUFFER_MINUTES;
	}
	return DEFAULT_TRANSFER_BUFFER_MINUTES;
}

// ── Planning ───────────────────────────────────────────────────

// A leg with both endpoints resolved to coordinates and labelled for the card.
export type ResolvedJourneyLeg = {
	mode: JourneyLegMode;
	from: LatLng;
	to: LatLng;
	fromLabel: string;
	toLabel: string;
};

export type PlannedJourneyLeg = ResolvedJourneyLeg & {
	// LOCAL date-times, region clock.
	departure: string;
	arrival: string;
	durationS: number;
	distanceM: number;
	// Exactly one of these, by mode.
	route?: RouteData;
	itinerary?: TransitItinerary;
};

export type JourneyPlan = {
	legs: PlannedJourneyLeg[];
	departure: string;
	arrival: string;
	durationS: number;
	distanceM: number;
	transfers: number;
	// The region timezone a transit leg reported, when one did.
	timezone?: string;
	// True when the plan was built backwards from an arrive-by deadline.
	plannedBackwards: boolean;
};

export type JourneyOutcome =
	| { ok: true; plan: JourneyPlan }
	| { ok: false; message: string };

function minutesBetween(from: string, to: string): number {
	const start = localToMinutes(from);
	const end = localToMinutes(to);
	if (start === null || end === null) return 0;
	return Math.max(0, end - start);
}

// A transit leg answers with ISO instants; the plan speaks local date-times,
// so the provider's timezone (when it reported one) does the conversion.
function toLocal(iso: string | undefined, timezone: string | undefined) {
	if (!iso) return undefined;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return undefined;
	return formatLocalDateTime(date, timezone);
}

/**
 * Plans the legs in order (or, with `arriveBy`, in reverse) and returns one
 * combined itinerary. Every upstream failure is surfaced as a message naming
 * the leg that failed — a journey is only honest when every leg of it is.
 */
export async function planJourney(
	input: {
		legs: ResolvedJourneyLeg[];
		departure?: string;
		arriveBy?: string;
	},
	deps: { provider: RoutingProvider },
): Promise<JourneyOutcome> {
	const { provider } = deps;
	const { legs } = input;
	if (legs.length === 0) {
		return { ok: false, message: "journey requires at least one leg." };
	}
	if (legs.some((leg) => leg.mode === "transit") && !provider.transit) {
		return {
			ok: false,
			message:
				"Public transport timetables are not available on this server, so a journey with a transit leg can't be planned. Say timetables are unavailable rather than inventing departures.",
		};
	}

	const planned: (PlannedJourneyLeg | undefined)[] = new Array(legs.length);
	let timezone: string | undefined;
	const backwards = Boolean(input.arriveBy);

	// Road legs only need a duration, so their provider call is identical in
	// both directions; only the anchor differs.
	async function roadLeg(
		leg: ResolvedJourneyLeg,
		anchor: { departure?: string; arrival?: string },
		index: number,
	): Promise<
		{ ok: true; leg: PlannedJourneyLeg } | { ok: false; message: string }
	> {
		const outcome = await provider.route({
			origin: leg.from,
			destination: leg.to,
			mode: leg.mode as RoutingMode,
		});
		if (!outcome.ok) {
			return {
				ok: false,
				message: `Leg ${index + 1} (${leg.mode} from ${leg.fromLabel} to ${leg.toLabel}) could not be routed: ${outcome.message}`,
			};
		}
		const durationS = Math.round(outcome.data.duration_s);
		const minutes = Math.max(1, Math.round(durationS / 60));
		const departure =
			anchor.departure ?? shiftLocal(anchor.arrival as string, -minutes);
		const arrival = anchor.arrival ?? shiftLocal(departure, minutes);
		return {
			ok: true,
			leg: {
				...leg,
				departure,
				arrival,
				durationS,
				distanceM: Math.round(outcome.data.distance_m),
				route: outcome.data,
			},
		};
	}

	async function transitLeg(
		leg: ResolvedJourneyLeg,
		anchor: { departure?: string; arrival?: string },
		index: number,
	): Promise<
		{ ok: true; leg: PlannedJourneyLeg } | { ok: false; message: string }
	> {
		const transit = provider.transit;
		if (!transit) {
			return { ok: false, message: "Public transport is unavailable." };
		}
		const outcome = await transit({
			origin: leg.from,
			destination: leg.to,
			...(anchor.arrival
				? { arrival: anchor.arrival }
				: anchor.departure
					? { departure: anchor.departure }
					: {}),
		});
		if (!outcome.ok) {
			return {
				ok: false,
				message: `Leg ${index + 1} (transit from ${leg.fromLabel} to ${leg.toLabel}) could not be planned: ${outcome.message}`,
			};
		}
		const itinerary = outcome.data.itineraries[0];
		if (!itinerary) {
			return {
				ok: false,
				message: `No public transport itinerary was found for leg ${index + 1} (${leg.fromLabel} → ${leg.toLabel}).`,
			};
		}
		timezone = timezone ?? outcome.data.timezone;
		const legTimezone = outcome.data.timezone;
		const durationS = Math.round(itinerary.duration_s);
		const minutes = Math.max(1, Math.round(durationS / 60));
		// Prefer the times the timetable actually returned; fall back to the
		// anchor plus the reported duration when the feed left them out.
		const departure =
			toLocal(itinerary.departure, legTimezone) ??
			anchor.departure ??
			shiftLocal(anchor.arrival as string, -minutes);
		const arrival =
			toLocal(itinerary.arrival, legTimezone) ?? shiftLocal(departure, minutes);
		return {
			ok: true,
			leg: {
				...leg,
				departure,
				arrival,
				durationS,
				distanceM: Math.round(itinerary.distance_m),
				itinerary,
			},
		};
	}

	if (backwards) {
		// Last leg first, against the deadline; each earlier leg must be in
		// before the next one leaves, minus its transfer buffer.
		let deadline = input.arriveBy as string;
		for (let i = legs.length - 1; i >= 0; i--) {
			const leg = legs[i];
			const anchor = { arrival: deadline };
			const result =
				leg.mode === "transit"
					? await transitLeg(leg, anchor, i)
					: await roadLeg(leg, anchor, i);
			if (!result.ok) return { ok: false, message: result.message };
			planned[i] = result.leg;
			if (i > 0) {
				deadline = shiftLocal(
					result.leg.departure,
					-transferBufferMinutes(legs[i - 1].mode, leg.mode),
				);
			}
		}
	} else {
		let cursor = input.departure ?? formatLocalDateTime(new Date(), undefined);
		for (let i = 0; i < legs.length; i++) {
			const leg = legs[i];
			const result =
				leg.mode === "transit"
					? await transitLeg(leg, { departure: cursor }, i)
					: await roadLeg(leg, { departure: cursor }, i);
			if (!result.ok) return { ok: false, message: result.message };
			planned[i] = result.leg;
			const next = legs[i + 1];
			if (next) {
				cursor = shiftLocal(
					result.leg.arrival,
					transferBufferMinutes(leg.mode, next.mode),
				);
			}
		}
	}

	const finalLegs = planned as PlannedJourneyLeg[];
	const departure = finalLegs[0].departure;
	const arrival = finalLegs[finalLegs.length - 1].arrival;
	return {
		ok: true,
		plan: {
			legs: finalLegs,
			departure,
			arrival,
			durationS: minutesBetween(departure, arrival) * 60,
			distanceM: finalLegs.reduce((total, leg) => total + leg.distanceM, 0),
			transfers: finalLegs.reduce(
				(total, leg) => total + (leg.itinerary?.transfers ?? 0),
				0,
			),
			...(timezone ? { timezone } : {}),
			plannedBackwards: backwards,
		},
	};
}
