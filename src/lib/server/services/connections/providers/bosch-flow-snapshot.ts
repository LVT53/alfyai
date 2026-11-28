import { readBoschFlowBikes, readBoschFlowRides } from "./bosch-flow-reader";

const id = (v: string | null) => (v && v.length <= 150 ? v : null);
const instant = (v: string | null) =>
	v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
export type Snapshot = {
	bikes: { id: string | null; name: string | null }[];
	rides: {
		id: string;
		bikeId?: string;
		startTime: string;
		endTime: string | null;
		distanceMeters: number | null;
	}[];
	complete: boolean;
};
export async function collectBoschBikeInventory(
	access: string,
	fetcher?: typeof fetch,
) {
	const raw = await readBoschFlowBikes(access, fetcher);
	return {
		bikes: raw
			.slice(0, 50)
			.map((b) => ({ id: id(b.id), name: b.name?.slice(0, 180) ?? null })),
		complete: raw.length <= 50,
	};
}
export async function collectBoschSnapshot(
	access: string,
	fetcher?: typeof fetch,
): Promise<Snapshot> {
	const inventory = await collectBoschBikeInventory(access, fetcher);
	const bikes = inventory.bikes;
	const rides: Snapshot["rides"] = [];
	let complete = inventory.complete;
	const seen = new Set<string>();
	let offset = 0;
	for (let page = 0; page < 40; page++) {
		const result = await readBoschFlowRides(access, offset, fetcher);
		if (result.rides.length > 50) throw new Error("Invalid ride page");
		for (const ride of result.rides) {
			const rideId = id(ride.id),
				startTime = instant(ride.startTime);
			if (!rideId || !startTime) {
				complete = false;
				continue;
			}
			if (seen.has(rideId)) continue;
			seen.add(rideId);
			rides.push({
				id: rideId,
				...(ride.bikeId ? { bikeId: ride.bikeId } : {}),
				startTime,
				endTime: instant(ride.endTime),
				distanceMeters: ride.distanceMeters,
			});
		}
		if (result.nextOffset === null) return { bikes, rides, complete };
		offset = result.nextOffset;
	}
	return { bikes, rides, complete: false };
}
