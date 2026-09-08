// Region-aware RoutingProvider.
//
// Wraps the on-demand region manager behind the same `RoutingProvider` seam
// the map_route tool already uses: every route / matrix / isochrone call first
// resolves which region its points fall in, makes sure that region's ORS is
// ready (or kicks off its download + build), then delegates to a plain ORS
// provider bound to that region's base URL. Geocoding goes to the shared
// Nominatim instance regardless of region.

import { formatLocalDateTime, toRegionLocalDateTime } from "./gtfs-feeds";
import type {
	EnsureRegionOutcome,
	RoutingRegionManager,
	RoutingRegionRow,
} from "./region-manager";
import type {
	IsochroneOutcome,
	LatLng,
	MatrixOutcome,
	RouteOutcome,
	RoutingFailureReason,
	RoutingMode,
	RoutingProvider,
	TransitOutcome,
	TransitQuery,
	TransitScheduleQuery,
} from "./types";

export type RegionalRoutingProviderParams = {
	manager: RoutingRegionManager;
	// Builds the per-region ORS provider for a resolved base URL.
	createProvider: (baseUrl: string) => RoutingProvider;
	// Shared geocoder-capable provider (any ORS base is fine; geocoding only
	// needs GEOCODER_BASE_URL).
	geocoder: RoutingProvider;
	requestedBy?: string | null;
	// Names of the regions currently ready, for the coverage label.
	readyRegionNames?: string[];
	// Names of the regions whose public-transport (GTFS) graph is ready, for
	// the timetable coverage label.
	transitRegionNames?: string[];
	onDemandEnabled: boolean;
	// Injected clock — a transit query with no explicit time departs "now" in
	// the REGION's timezone, so this has to be substitutable in tests.
	now?: () => number;
};

type Failure = { ok: false; reason: RoutingFailureReason; message: string };

function formatMb(bytes: number): string {
	return `${Math.round(bytes / 1048576)} MB`;
}

// Translate a region outcome into a routing failure the tool can narrate.
export function regionOutcomeToFailure(
	outcome: EnsureRegionOutcome,
): Failure | null {
	switch (outcome.kind) {
		case "ready":
			return null;
		case "preparing": {
			const phase =
				outcome.status === "starting"
					? "its routing engine is starting (usually 1–3 minutes)"
					: outcome.status === "downloading"
						? "the map extract is downloading"
						: outcome.status === "building"
							? "the routing graph is being built (usually 10–40 minutes)"
							: "it is queued for download and graph build (usually 10–40 minutes)";
			return {
				ok: false,
				reason: "region_preparing",
				message: `Routing data for ${outcome.region.name} is not ready yet: ${phase}.`,
			};
		}
		case "multi_region":
			return {
				ok: false,
				reason: "multi_region",
				message: `The points fall in different map regions (${outcome.regions.join(", ")}); only routing within a single region is supported.`,
			};
		case "unknown_region":
			return {
				ok: false,
				reason: "out_of_coverage",
				message:
					"No map extract covers that coordinate (it may be at sea or outside OpenStreetMap region boundaries).",
			};
		case "too_large":
			return {
				ok: false,
				reason: "region_unavailable",
				message: `The map extracts covering that point (${outcome.regions.join(", ")}) exceed the on-demand size cap of ${formatMb(outcome.maxPbfBytes)}.`,
			};
		case "disabled":
			return {
				ok: false,
				reason: "region_unavailable",
				message: `That point is in ${outcome.region.name}, which is not loaded on this server, and on-demand region downloads are disabled.`,
			};
		case "error":
			return {
				ok: false,
				reason: "region_unavailable",
				message: `Preparing routing data for ${outcome.region.name} failed (${outcome.message}). An administrator can retry it.`,
			};
		default:
			return {
				ok: false,
				reason: "provider_error",
				message: "unknown region outcome",
			};
	}
}

export function createRegionalRoutingProvider(
	params: RegionalRoutingProviderParams,
): RoutingProvider {
	const { manager, createProvider, geocoder } = params;

	const now = params.now ?? Date.now;

	async function resolve(
		points: LatLng[],
	): Promise<
		| { provider: RoutingProvider; region: RoutingRegionRow }
		| { failure: Failure }
	> {
		const outcome = await manager.ensureRegionForPoints(points, {
			requestedBy: params.requestedBy ?? null,
		});
		const failure = regionOutcomeToFailure(outcome);
		if (failure) return { failure };
		if (outcome.kind !== "ready") {
			return {
				failure: {
					ok: false,
					reason: "provider_error",
					message: "region not ready",
				},
			};
		}
		return {
			provider: createProvider(outcome.baseUrl),
			region: outcome.region,
		};
	}

	// Timetables live on a per-region `public-transport` ORS profile, so a
	// transit call is only possible once THAT region's GTFS graph is ready —
	// its road graph being ready says nothing about it.
	function transitFailure(region: RoutingRegionRow): Failure | null {
		switch (region.transitStatus) {
			case "ready":
				return null;
			case "queued":
			case "building":
				return {
					ok: false,
					reason: "transit_unavailable",
					message: `The public transport timetable for ${region.name} is still being built on this server; it is usually ready within an hour.`,
				};
			case "error":
				return {
					ok: false,
					reason: "transit_unavailable",
					message: `The public transport timetable for ${region.name} could not be built on this server. An administrator can retry it.`,
				};
			default:
				return {
					ok: false,
					reason: "transit_unavailable",
					message: `No public transport timetable is loaded for ${region.name} on this server.`,
				};
		}
	}

	// Fill in the departure ORS needs. Its `departure`/`arrival` parameters are
	// LOCAL date-times, so "now" has to be expressed in the region's own
	// timezone — the server's clock would be wrong for any region in another
	// zone. `timezone` is null only when it could not be derived, in which case
	// formatLocalDateTime falls back to server-local time.
	function withDefaultTiming<T extends TransitQuery>(
		input: T,
		region: RoutingRegionRow,
	): T {
		const normalize = (value: string | undefined) =>
			value ? toRegionLocalDateTime(value, region.timezone, now()) : null;
		const arrival = normalize(input.arrival);
		const departure = normalize(input.departure);
		if (arrival) return { ...input, arrival, departure: undefined };
		if (departure) return { ...input, departure, arrival: undefined };
		// Nothing usable was given (or what was given did not parse): depart now,
		// expressed in the REGION's local time.
		return {
			...input,
			departure: formatLocalDateTime(new Date(now()), region.timezone),
			arrival: undefined,
		};
	}

	function withTimezone(
		outcome: TransitOutcome,
		region: RoutingRegionRow,
	): TransitOutcome {
		if (!outcome.ok || !region.timezone) return outcome;
		return { ...outcome, data: { ...outcome.data, timezone: region.timezone } };
	}

	return {
		routingConfigured: () =>
			params.onDemandEnabled || (params.readyRegionNames?.length ?? 0) > 0,
		geocoderConfigured: () => geocoder.geocoderConfigured(),
		coverageLabel: () => {
			const ready = params.readyRegionNames ?? [];
			const loaded = ready.length > 0 ? ready.join(", ") : "no region yet";
			return params.onDemandEnabled
				? `${loaded} (other regions are downloaded and built on demand, which takes 10–40 minutes on first use)`
				: loaded;
		},
		transitCoverageLabel: () => (params.transitRegionNames ?? []).join(", "),
		geocode: (input) => geocoder.geocode(input),
		async route(input): Promise<RouteOutcome> {
			const resolved = await resolve([
				input.origin,
				...(input.waypoints ?? []),
				input.destination,
			]);
			if ("failure" in resolved) return resolved.failure;
			return resolved.provider.route(input);
		},
		async matrix(input): Promise<MatrixOutcome> {
			const resolved = await resolve([...input.origins, ...input.destinations]);
			if ("failure" in resolved) return resolved.failure;
			return resolved.provider.matrix(input);
		},
		async isochrone(input: {
			origin: LatLng;
			mode: RoutingMode;
			rangesS: number[];
		}): Promise<IsochroneOutcome> {
			const resolved = await resolve([input.origin]);
			if ("failure" in resolved) return resolved.failure;
			return resolved.provider.isochrone(input);
		},
		async transit(input: TransitQuery): Promise<TransitOutcome> {
			const resolved = await resolve([input.origin, input.destination]);
			if ("failure" in resolved) return resolved.failure;
			const unavailable = transitFailure(resolved.region);
			if (unavailable) return unavailable;
			const call = resolved.provider.transit;
			if (!call) {
				return {
					ok: false,
					reason: "transit_unavailable",
					message: "Public transport routing is not available on this server.",
				};
			}
			return withTimezone(
				await call(withDefaultTiming(input, resolved.region)),
				resolved.region,
			);
		},
		async transitSchedule(
			input: TransitScheduleQuery,
		): Promise<TransitOutcome> {
			const resolved = await resolve([input.origin, input.destination]);
			if ("failure" in resolved) return resolved.failure;
			const unavailable = transitFailure(resolved.region);
			if (unavailable) return unavailable;
			const call = resolved.provider.transitSchedule;
			if (!call) {
				return {
					ok: false,
					reason: "transit_unavailable",
					message: "Public transport routing is not available on this server.",
				};
			}
			return withTimezone(
				await call(withDefaultTiming(input, resolved.region)),
				resolved.region,
			);
		},
	};
}
