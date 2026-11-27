import {
	bearerAuthHeader,
	ConnectionHttpError,
	providerFetch,
} from "../provider-http";
import { boschJson } from "./bosch-flow-json";

const endpoints = {
	bikes: "https://api.bosch-ebike.com/bike-profile/smart-system/v1/bikes",
	rides: "https://api.bosch-ebike.com/activity/smart-system/v1/activities",
} as const;

async function getPage(url: URL, token: string, fetchImpl?: typeof fetch) {
	const response = await providerFetch(url.href, {
		headers: { ...bearerAuthHeader(token), Accept: "application/json" },
		redirect: "error",
		fetch: fetchImpl,
	});
	if (!response.ok) {
		const reason =
			response.status === 401
				? "expired"
				: response.status === 403
					? "access_denied"
					: response.status === 429
						? "rate_limited"
						: "request_failed";
		throw new ConnectionHttpError("Could not retrieve Bosch Flow data", reason);
	}
	return boschJson(response, 6 * 1024 * 1024);
}

function records(value: unknown): Record<string, unknown>[] {
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
	const page = await getPage(new URL(endpoints.bikes), token, fetchImpl);
	return records(page?.bikes).map((bike) => ({
		id: typeof bike.id === "string" ? bike.id : null,
		name: typeof bike.name === "string" ? bike.name : null,
	}));
}

export async function readBoschFlowRides(
	token: string,
	offset = 0,
	fetchImpl?: typeof fetch,
) {
	if (!Number.isSafeInteger(offset) || offset < 0)
		throw new RangeError("Invalid Bosch ride offset");
	const url = new URL(endpoints.rides);
	url.search = new URLSearchParams({
		limit: "50",
		offset: String(offset),
		sort: "-startTime",
	}).toString();
	const page = await getPage(url, token, fetchImpl);
	const rows = records(page?.activitySummaries);
	const rides = rows.map((ride) => ({
		id: typeof ride.id === "string" ? ride.id : null,
		startTime: typeof ride.startTime === "string" ? ride.startTime : null,
		endTime: typeof ride.endTime === "string" ? ride.endTime : null,
		distanceMeters:
			typeof ride.distance === "number" &&
			Number.isFinite(ride.distance) &&
			ride.distance >= 0
				? ride.distance
				: null,
	}));
	const pg = page.pagination;
	const count =
		pg &&
		typeof pg === "object" &&
		"total" in pg &&
		typeof pg.total === "number"
			? pg.total
			: NaN;
	const next = offset + rides.length;
	const hasMore =
		Number.isSafeInteger(count) && count >= 0
			? next < count
			: rides.length === 50;
	if (hasMore && rides.length === 0) {
		throw new ConnectionHttpError(
			"Missing page in Bosch ride history",
			"incomplete_history",
		);
	}
	return { rides, nextOffset: hasMore ? next : null };
}
