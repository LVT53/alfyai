// Region-aware RoutingProvider.
//
// Wraps the on-demand region manager behind the same `RoutingProvider` seam
// the map_route tool already uses: every route / matrix / isochrone call first
// resolves which region its points fall in, makes sure that region's ORS is
// ready (or kicks off its download + build), then delegates to a plain ORS
// provider bound to that region's base URL. Geocoding goes to the shared
// Nominatim instance regardless of region.

import type {
	EnsureRegionOutcome,
	RoutingRegionManager,
} from "./region-manager";
import type {
	IsochroneOutcome,
	LatLng,
	MatrixOutcome,
	RouteOutcome,
	RoutingFailureReason,
	RoutingMode,
	RoutingProvider,
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
	onDemandEnabled: boolean;
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

	async function resolve(
		points: LatLng[],
	): Promise<{ provider: RoutingProvider } | { failure: Failure }> {
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
		return { provider: createProvider(outcome.baseUrl) };
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
	};
}
