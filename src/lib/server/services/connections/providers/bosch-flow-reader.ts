import {
	bearerAuthHeader,
	ConnectionHttpError,
	providerFetch,
} from "../provider-http";
import { boschJson } from "./bosch-flow-json";

export const boschFlowEndpoints = {
	bikes: "https://api.bosch-ebike.com/bike-profile/smart-system/v1/bikes",
	rides: "https://api.bosch-ebike.com/activity/smart-system/v1/activities",
} as const;

export async function getBoschPage(
	url: URL,
	token: string,
	fetchImpl?: typeof fetch,
) {
	if (
		url.origin !== "https://api.bosch-ebike.com" ||
		url.username ||
		url.password
	)
		throw new ConnectionHttpError(
			"Invalid Bosch API address",
			"invalid_request",
		);
	const response = await providerFetch(url.href, {
		headers: { ...bearerAuthHeader(token), Accept: "application/json" },
		redirect: "error",
		fetch: fetchImpl,
	});
	if (!response.ok) {
		const reason =
			response.status === 401
				? "expired"
				: response.status === 404
					? "not_found"
					: response.status === 403
						? "access_denied"
						: response.status === 429
							? "rate_limited"
							: "request_failed";
		throw new ConnectionHttpError("Could not retrieve Bosch Flow data", reason);
	}
	return boschJson(response, 6 * 1024 * 1024);
}

export function boschRecords(value: unknown): Record<string, unknown>[] {
	if (
		!Array.isArray(value) ||
		value.some(
			(item) => !item || typeof item !== "object" || Array.isArray(item),
		)
	) {
		throw new ConnectionHttpError(
			"Unexpected Bosch Flow response",
			"invalid_response",
		);
	}
	return value;
}

export async function readBoschFlowBikes(
	token: string,
	fetchImpl?: typeof fetch,
) {
	const page = await getBoschPage(
		new URL(boschFlowEndpoints.bikes),
		token,
		fetchImpl,
	);
	return boschRecords(page?.bikes).map((bike) => ({
		id: typeof bike.id === "string" ? bike.id : null,
		name: typeof bike.name === "string" ? bike.name : null,
	}));
}

export async function readBoschRidePage(
	token: string,
	offset = 0,
	fetchImpl?: typeof fetch,
) {
	if (!Number.isSafeInteger(offset) || offset < 0)
		throw new RangeError("Invalid Bosch ride offset");
	const url = new URL(boschFlowEndpoints.rides);
	url.search = new URLSearchParams({
		limit: "50",
		offset: String(offset),
		sort: "-startTime",
	}).toString();
	const page = await getBoschPage(url, token, fetchImpl);
	const rows = boschRecords(page?.activitySummaries);
	if (rows.length > 50)
		throw new ConnectionHttpError(
			"Invalid Bosch ride page",
			"invalid_response",
		);

	const pg = page.pagination;
	const count =
		pg &&
		typeof pg === "object" &&
		"total" in pg &&
		typeof pg.total === "number"
			? pg.total
			: NaN;
	const next = offset + rows.length;
	const hasMore =
		Number.isSafeInteger(count) && count >= 0
			? next < count
			: rows.length === 50;
	if (hasMore && rows.length === 0) {
		throw new ConnectionHttpError(
			"Missing page in Bosch ride history",
			"incomplete_history",
		);
	}
	return { rows, nextOffset: hasMore ? next : null };
}

export async function readBoschFlowRides(
	token: string,
	offset = 0,
	fetchImpl?: typeof fetch,
) {
	const { rows, nextOffset } = await readBoschRidePage(
		token,
		offset,
		fetchImpl,
	);
	const rides = rows.map((ride) => ({
		id: typeof ride.id === "string" ? ride.id : null,
		...(typeof ride.bikeId === "string" &&
		ride.bikeId.length > 0 &&
		ride.bikeId.length <= 150
			? { bikeId: ride.bikeId }
			: {}),
		startTime: typeof ride.startTime === "string" ? ride.startTime : null,
		endTime: typeof ride.endTime === "string" ? ride.endTime : null,
		distanceMeters:
			typeof ride.distance === "number" &&
			Number.isFinite(ride.distance) &&
			ride.distance >= 0
				? ride.distance
				: null,
	}));
	return { rides, nextOffset };
}
