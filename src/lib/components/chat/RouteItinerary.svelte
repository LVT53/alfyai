<script lang="ts" module>
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
</script>

<script lang="ts">
// The step-by-step body of a route card: the mode strip and summary line, the
// map (handed in as a snippet so this component never pulls MapLibre in), and
// then the directions — a manoeuvre list for a road route, a timeline for a
// public-transport one, and BOTH for a mixed-mode journey.
//
// It is presentation only: every fact it draws (times, manoeuvres, line
// names, distances) was computed server-side and persisted on the map card,
// so a reloaded conversation renders exactly the same itinerary. Nothing here
// derives a time or a distance of its own.
//
// Hovering a step or a leg highlights that stretch on the map, and clicking it
// asks the map to pan/zoom there — both by handing the range back through the
// `mapSurface` snippet, which is what mounts the map component.
import type { Snippet } from "svelte";
import { slide } from "svelte/transition";
import { t } from "$lib/i18n";
import type {
	ToolCallMapData,
	ToolCallMapStep,
	ToolCallMapTransitLeg,
} from "$lib/server/services/messages-types";
import {
	formatMapDistance,
	formatMapDuration,
} from "$lib/utils/tool-activity";
import { reducedMotionAware } from "$lib/utils/motion";

// The four modes the strip always shows, in the mockup's order.
const MODE_STRIP = [
	["car", "routeItinerary.modeCar"],
	["walk", "routeItinerary.modeWalk"],
	["bike", "routeItinerary.modeBike"],
	["transit", "routeItinerary.modeTransit"],
] as const;

let {
	map,
	summary = "",
	mapSurface = undefined,
}: {
	map: ToolCallMapData;
	// The row's own one-line summary, used as the head text only when the card
	// carries no structured facts of its own (an older persisted card).
	summary?: string;
	mapSurface?: Snippet<[ItineraryRange | null, ItineraryRange | null]>;
} = $props();

const slideTransition = reducedMotionAware(slide);

// How many manoeuvres are shown before the "Show all N steps" disclosure.
const COLLAPSED_STEPS = 7;

let showAllSteps = $state(false);
let hoveredRange = $state<ItineraryRange | null>(null);
let focusedRange = $state<ItineraryRange | null>(null);

let legs = $derived(map.transitLegs ?? []);
let steps = $derived(map.steps ?? []);
let departures = $derived(map.departures ?? []);
let visibleSteps = $derived(
	showAllSteps ? steps : steps.slice(0, COLLAPSED_STEPS),
);

// The mode strip: every mode this journey actually uses is filled in.
let activeModes = $derived.by(() => {
	const active = new Set<string>();
	if (map.mode === "drive") active.add("car");
	if (map.mode === "walk") active.add("walk");
	if (map.mode === "bike") active.add("bike");
	if (map.mode === "transit") active.add("transit");
	for (const leg of legs) {
		if (leg.type === "pt") active.add("transit");
		else if (leg.type === "drive") active.add("car");
		else if (leg.type === "bike") active.add("bike");
		else active.add("walk");
	}
	return active;
});

// The bold half of the summary line: distance and time for a road route, the
// clock span for anything with times on it.
let headPrimary = $derived.by(() => {
	if (map.departAt && map.arriveAt) {
		return map.mode === "journey"
			? $t("routeItinerary.leaveArrive", {
					depart: map.departAt,
					arrive: map.arriveAt,
				})
			: `${map.departAt} → ${map.arriveAt}`;
	}
	const parts = [
		formatMapDistance(map.distanceM),
		formatMapDuration(map.durationS),
	].filter((part) => part.length > 0);
	return parts.join(" · ");
});

// The muted facts after it, in the order the mockup reads them.
let headParts = $derived.by(() => {
	const parts: string[] = [];
	const hasTimes = Boolean(map.departAt && map.arriveAt);
	if (hasTimes) {
		const duration = formatMapDuration(map.durationS);
		if (duration) parts.push(duration);
	}
	if (map.transfers !== undefined && legs.some((leg) => leg.type === "pt")) {
		parts.push($t("routeItinerary.changesCount", { count: map.transfers }));
	}
	if (map.via) parts.push($t("routeItinerary.via", { road: map.via }));
	if (map.ascentM !== undefined && map.ascentM >= 1) {
		parts.push($t("routeItinerary.climb", { meters: Math.round(map.ascentM) }));
	}
	if (map.arriveBy) {
		parts.push($t("routeItinerary.arriveBy", { time: map.arriveBy }));
	}
	if (map.departDate) parts.push(formatDate(map.departDate));
	return parts;
});

// "2026-09-09" → "Tue 9 Sep" in the user's own locale. The date itself was
// resolved server-side in the journey's region; this only formats it.
function formatDate(iso: string): string {
	const date = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(date.getTime())) return iso;
	try {
		return new Intl.DateTimeFormat(undefined, {
			weekday: "short",
			day: "numeric",
			month: "short",
		}).format(date);
	} catch {
		return iso;
	}
}

// ── Timeline rows ──────────────────────────────────────────────

type TimelineRow = {
	key: string;
	time: string;
	name: string;
	// The rail below this node: a coloured line for a ride, a dashed one for a
	// walk or a change, nothing at all for the final stop.
	kind: "ride" | "walk" | "last";
	color: string;
	glyph: ItineraryGlyph;
	badge?: string;
	headsign?: string;
	platform?: string;
	stops?: number;
	detail?: string;
	range: ItineraryRange | null;
	steps: ToolCallMapStep[];
	stepsLabel?: string;
};

function legGlyph(leg: ToolCallMapTransitLeg): ItineraryGlyph {
	if (leg.type === "pt") return glyphForVehicle(leg.vehicle);
	if (leg.type === "drive") return "car";
	if (leg.type === "bike") return "bike";
	return "walk";
}

// A walk leg with no ground to cover between two services is a CHANGE, not a
// walk — the difference is what the row says and which icon it carries.
function isChange(leg: ToolCallMapTransitLeg): boolean {
	return leg.type === "walk" && !(leg.distanceM && leg.distanceM > 50);
}

let timeline = $derived.by((): TimelineRow[] => {
	if (legs.length === 0) return [];
	const rows: TimelineRow[] = [];
	legs.forEach((leg, index) => {
		const glyph = isChange(leg) ? "change" : legGlyph(leg);
		const previous = legs[index - 1];
		const name =
			leg.from ?? previous?.to ?? (index === 0 ? (map.originLabel ?? "") : "");
		const minutes = leg.minutes;
		const distance = leg.distanceM ? formatMapDistance(leg.distanceM) : "";
		const row: TimelineRow = {
			key: `leg-${index}`,
			time: leg.depart ?? "",
			name,
			kind: leg.type === "pt" ? "ride" : "walk",
			color: itineraryLineColor(
				leg.type === "pt" ? glyphForVehicle(leg.vehicle) : legGlyph(leg),
				leg.line,
				leg.color,
			),
			glyph,
			range: leg.pointRange ?? null,
			steps: leg.steps ?? [],
		};
		if (leg.type === "pt") {
			row.badge = leg.line ?? leg.vehicle ?? "";
			if (leg.headsign) row.headsign = leg.headsign;
			if (leg.platform) row.platform = leg.platform;
			if (leg.stops !== undefined) row.stops = leg.stops;
		} else if (leg.type === "walk") {
			const label = isChange(leg)
				? $t("routeItinerary.change")
				: $t("toolActivity.transitWalk");
			row.detail = [
				`${label} ${$t("routeItinerary.minutes", { count: minutes })}`,
				distance,
			]
				.filter(Boolean)
				.join(" · ");
		} else {
			// A self-powered leg of a mixed journey rides the timeline with a
			// badge of its own, so a cycle leg reads like a service.
			row.badge = $t(
				leg.type === "bike" ? "routeItinerary.cycle" : "routeItinerary.drive",
			);
			row.detail = [distance, formatMapDuration(minutes * 60)]
				.filter(Boolean)
				.join(" · ");
			if (row.steps.length > 0) {
				row.stepsLabel = $t(
					leg.type === "bike"
						? "routeItinerary.cyclingDirections"
						: "routeItinerary.drivingDirections",
					{ distance },
				);
			}
		}
		rows.push(row);
	});
	const last = legs[legs.length - 1];
	rows.push({
		key: "arrival",
		time: last.arrive ?? map.arriveAt ?? "",
		name: last.to ?? map.destinationLabel ?? "",
		kind: "last",
		color: "transparent",
		glyph: "walk",
		range: null,
		steps: [],
	});
	return rows;
});

// The self-powered legs of a journey print their manoeuvres UNDER the
// timeline, each under its own heading, exactly as the mockup reads.
let legDirections = $derived(
	timeline.filter((row) => row.steps.length > 0 && row.stepsLabel),
);

function hover(range: ItineraryRange | null) {
	hoveredRange = range;
}

function pin(range: ItineraryRange | null) {
	focusedRange = range;
	hoveredRange = range;
}
</script>

{#snippet modeIcon(name: string)}
	{#if name === 'car'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>
	{:else if name === 'walk'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13" cy="4" r="1.5"/><path d="m8 22 3-7"/><path d="m11 15 2-3 3 2 2 5"/><path d="M13 12 9 9l-3 4"/><path d="m11 8 2 4"/></svg>
	{:else if name === 'bike'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>
	{:else if name === 'tram'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="6" width="14" height="12" rx="2"/><path d="M5 12h14"/><path d="M9 2l3 4 3-4"/><path d="M8 18l-1 3"/><path d="m16 18 1 3"/></svg>
	{:else if name === 'bus'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/></svg>
	{:else if name === 'ferry'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 20a3 3 0 0 0 3-1 3 3 0 0 1 5 0 3 3 0 0 0 5 0 3 3 0 0 1 5 0 3 3 0 0 0 3 1"/><path d="M4 16 3 9h18l-1 7"/><path d="M12 3v6"/></svg>
	{:else if name === 'change'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>
	{:else}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/><path d="M8 19l-2 3"/><path d="m18 22-2-3"/><path d="M8 15h.01"/><path d="M16 15h.01"/></svg>
	{/if}
{/snippet}

{#snippet turnIcon(maneuver: ToolCallMapManeuver)}
	{@const glyph = maneuverGlyph(maneuver)}
	{#if glyph === 'left'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
	{:else if glyph === 'right'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>
	{:else if glyph === 'roundabout'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="4"/><path d="M12 21v-4"/><path d="M16 10l3-3"/><path d="m19 7-4 0"/><path d="m19 7 0 4"/></svg>
	{:else if glyph === 'flag'}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22V4c0-.5.2-1 .6-1.4C5 2.2 5.5 2 6 2h13l-3 5 3 5H4"/></svg>
	{:else}
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V4"/><path d="m6 10 6-6 6 6"/></svg>
	{/if}
{/snippet}

{#snippet stepList(list: ToolCallMapStep[])}
	<div class="ri-steps">
		{#each list as step, index (index)}
			<button
				type="button"
				class="ri-step"
				class:is-active={step.wayPointRange &&
					focusedRange &&
					step.wayPointRange[0] === focusedRange[0]}
				data-testid="itinerary-step"
				onmouseenter={() => hover(step.wayPointRange ?? null)}
				onmouseleave={() => hover(null)}
				onfocus={() => hover(step.wayPointRange ?? null)}
				onblur={() => hover(null)}
				onclick={() => pin(step.wayPointRange ?? null)}
			>
				<span class="ri-step-icon">{@render turnIcon(step.maneuver)}</span>
				<span class="ri-step-text">
					{step.instruction}
					{#if step.name}<small>{step.name}</small>{/if}
				</span>
				<span class="ri-step-distance">
					{step.distanceM > 0 ? formatMapDistance(step.distanceM) : ''}
				</span>
			</button>
		{/each}
	</div>
{/snippet}

<div class="ri" data-testid="route-itinerary">
	<div class="ri-head">
		<span class="ri-modes" aria-hidden="true">
			{#each MODE_STRIP as [name, key] (name)}
				<span
					class="ri-mode"
					class:is-on={activeModes.has(name)}
					data-mode={name}
					data-active={activeModes.has(name) ? 'true' : 'false'}
					title={$t(key)}
				>
					{@render modeIcon(name === 'transit' ? 'train' : name)}
				</span>
			{/each}
		</span>
		<b data-testid="itinerary-head">{headPrimary || summary}</b>
		{#each headParts as part, index (index)}
			<span aria-hidden="true">·</span>
			<span>{part}</span>
		{/each}
	</div>

	{@render mapSurface?.(hoveredRange, focusedRange)}

	{#if timeline.length > 0}
		<div class="ri-timeline" data-testid="itinerary-timeline">
			{#each timeline as row (row.key)}
				<div
					class="ri-tl-row"
					class:is-last={row.kind === 'last'}
					data-testid="itinerary-leg"
					data-kind={row.kind}
					style={`--ri-line: ${row.color}`}
					onmouseenter={() => hover(row.range)}
					onmouseleave={() => hover(null)}
				>
					<span class="ri-tl-time">{row.time}</span>
					<span class="ri-tl-rail" class:is-walk={row.kind === 'walk'}>
						<span class="ri-tl-node"></span>
						<span class="ri-tl-line"></span>
					</span>
					<span class="ri-tl-body">
						<span class="ri-tl-name">{row.name}</span>
						{#if row.badge || row.detail}
							<span class="ri-tl-sub">
								{#if row.badge}
									<span class="ri-badge" style={`--ri-line: ${row.color}`}>
										<span class="ri-badge-icon">{@render modeIcon(row.glyph)}</span>
										{row.badge}
									</span>
								{/if}
								{#if row.headsign}
									<span>{$t('routeItinerary.toward', { place: row.headsign })}</span>
								{/if}
								{#if row.platform}
									<span>{$t('routeItinerary.platform', { platform: row.platform })}</span>
								{/if}
								{#if row.stops !== undefined}
									<span>{$t('toolActivity.transitStops', { count: row.stops })}</span>
								{/if}
								{#if row.detail}
									<span class="ri-tl-detail">
										<span class="ri-tl-detail-icon">{@render modeIcon(row.glyph)}</span>
										{row.detail}
									</span>
								{/if}
							</span>
						{/if}
					</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if departures.length > 0}
		<div class="ri-eyebrow">{$t('routeItinerary.otherDepartures')}</div>
		{#each departures as departure, index (index)}
			<div class="ri-alt" data-testid="itinerary-departure">
				<b>{departure.depart ?? ''}</b>
				{#if departure.line}
					<span class="ri-badge ri-badge--muted">{departure.line}</span>
				{/if}
				<span>
					→ {departure.arrive ?? ''} · {formatMapDuration(departure.minutes * 60)}
					· {$t('routeItinerary.changesCount', { count: departure.transfers })}
				</span>
			</div>
		{/each}
	{/if}

	{#if steps.length > 0}
		<div class="ri-eyebrow">{$t('routeItinerary.directions')}</div>
		{@render stepList(visibleSteps)}
		{#if steps.length > COLLAPSED_STEPS}
			<button
				type="button"
				class="ri-more"
				data-testid="itinerary-show-all"
				onclick={() => {
					showAllSteps = !showAllSteps;
				}}
			>
				{showAllSteps
					? $t('routeItinerary.showFewerSteps')
					: $t('routeItinerary.showAllSteps', { count: steps.length })}
			</button>
		{/if}
	{/if}

	{#each legDirections as row (row.key)}
		<div class="ri-eyebrow">{row.stepsLabel}</div>
		<div transition:slideTransition={{ duration: 200 }}>
			{@render stepList(row.steps)}
		</div>
	{/each}
</div>

<style>
	.ri {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.ri-head {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		color: var(--text-muted);
	}

	.ri-head b {
		color: var(--text-primary);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.ri-modes {
		display: inline-flex;
		gap: 2px;
	}

	.ri-mode {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 5px;
		color: var(--text-muted);
	}

	/* The modes this journey actually uses are filled; the rest stay as ghosts
	   so the strip always reads as the same four choices. */
	.ri-mode.is-on {
		background: var(--text-primary);
		color: var(--surface-page);
	}

	.ri-mode :global(svg),
	.ri-badge-icon :global(svg),
	.ri-tl-detail-icon :global(svg) {
		width: 14px;
		height: 14px;
	}

	.ri-eyebrow {
		margin-top: 2px;
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--text-muted);
	}

	/* ── Directions list ─────────────────────────────────────── */

	.ri-steps {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.ri-step {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		width: calc(100% + 12px);
		margin: 0 -6px;
		padding: 5px 6px;
		border: none;
		border-radius: 5px;
		background: transparent;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.ri-step:hover,
	.ri-step:focus-visible,
	.ri-step.is-active {
		background: var(--surface-page);
	}

	.ri-step:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.ri-step-icon {
		flex: 0 0 22px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 1px solid var(--border-subtle);
		background: var(--surface-page);
		color: var(--text-primary);
	}

	.ri-step-icon :global(svg) {
		width: 14px;
		height: 14px;
	}

	.ri-step-text {
		flex: 1 1 auto;
		min-width: 0;
		line-height: 1.4;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	.ri-step-text small {
		display: block;
		color: var(--text-muted);
	}

	.ri-step-distance {
		flex: 0 0 auto;
		padding-top: 2px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.ri-more {
		align-self: flex-start;
		margin-left: 26px;
		padding: 4px 0 0;
		border: none;
		background: none;
		font: inherit;
		color: var(--text-muted);
		cursor: pointer;
	}

	.ri-more:hover,
	.ri-more:focus-visible {
		color: var(--text-primary);
	}

	/* ── Transit / journey timeline ──────────────────────────── */

	.ri-timeline {
		display: grid;
		grid-template-columns: 44px 18px minmax(0, 1fr);
		column-gap: 8px;
	}

	/* The row is a DOM grouping only — `display: contents` lets its three cells
	   sit in the timeline's own grid, so the times column stays aligned
	   without needing subgrid. */
	.ri-tl-row {
		display: contents;
	}

	.ri-tl-time {
		grid-column: 1;
		padding: 5px 0;
		text-align: right;
		color: var(--text-primary);
		font-variant-numeric: tabular-nums;
	}

	.ri-tl-rail {
		position: relative;
		grid-column: 2;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.ri-tl-node {
		position: absolute;
		left: 4px;
		top: 8px;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 2px solid var(--ri-line, var(--text-primary));
		background: var(--surface-elevated);
		box-sizing: border-box;
		z-index: 1;
	}

	.ri-tl-line {
		flex: 1 1 auto;
		width: 4px;
		min-height: 100%;
		border-radius: 2px;
		background: var(--ri-line, var(--border-subtle));
	}

	/* A walk or a change is drawn as a dashed rail — it is time spent, but not
	   on a service. */
	.ri-tl-rail.is-walk .ri-tl-line {
		width: 0;
		border-left: 2px dashed var(--text-muted);
		background: none;
		border-radius: 0;
	}

	.ri-tl-row.is-last .ri-tl-line {
		background: transparent;
		border: none;
	}

	.ri-tl-row.is-last .ri-tl-node {
		border-color: var(--text-primary);
	}

	.ri-tl-body {
		grid-column: 3;
		min-width: 0;
		padding: 5px 0 8px;
	}

	.ri-tl-name {
		display: block;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	.ri-tl-sub {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 1px;
		color: var(--text-muted);
	}

	.ri-tl-detail {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.ri-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 18px;
		padding: 0 6px;
		border-radius: 4px;
		background: var(--ri-line, var(--text-primary));
		color: #fff;
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: 0.02em;
	}

	.ri-badge--muted {
		background: var(--text-muted);
	}

	.ri-badge-icon {
		display: inline-flex;
	}

	.ri-alt {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 -6px;
		padding: 4px 6px;
		border-radius: 5px;
		color: var(--text-muted);
	}

	.ri-alt b {
		color: var(--text-primary);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}
</style>
