import {
	bearerAuthHeader,
	ConnectionHttpError,
	providerFetch,
} from "../provider-http";

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
	return response.json();
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
	const count = page.pagination?.total;
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

// The interval is half-open so a ride at midnight belongs to one period.
export async function summarizeBoschFlowRides(
	token: string,
	start: Date,
	end: Date,
	fetchImpl?: typeof fetch,
) {
	const from = start.getTime();
	const until = end.getTime();
	if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until)
		throw new RangeError("Invalid Bosch ride interval");
	const seen = new Set<string>();
	let rideCount = 0;
	let measuredDistanceMeters = 0;
	let ridesWithoutDistance = 0;
	let complete = true;
	let offset = 0;
	// Bound response time and tell the caller when older pages remain.
	for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
		const page = await readBoschFlowRides(token, offset, fetchImpl);
		for (const ride of page.rides) {
			const time = ride.startTime ? Date.parse(ride.startTime) : NaN;
			if (!ride.id || !Number.isFinite(time)) {
				complete = false;
				continue;
			}
			if (time < from || time >= until || seen.has(ride.id)) continue;
			seen.add(ride.id);
			rideCount++;
			if (ride.distanceMeters === null) ridesWithoutDistance++;
			else measuredDistanceMeters += ride.distanceMeters;
		}
		if (page.nextOffset === null)
			return {
				rideCount,
				measuredDistanceMeters,
				ridesWithoutDistance,
				complete,
			};
		offset = page.nextOffset;
	}
	return {
		rideCount,
		measuredDistanceMeters,
		ridesWithoutDistance,
		complete: false,
	};
}
