import { ConnectionHttpError } from "../provider-http";
import {
	type BoschDetailQuery,
	parseBoschDetailQuery,
	projectBoschDetail,
} from "./bosch-flow-details";
import {
	boschFlowEndpoints,
	boschRecords,
	getBoschPage,
	readBoschRidePage,
} from "./bosch-flow-reader";

const api = "https://api.bosch-ebike.com";
const routes = {
	...boschFlowEndpoints,
	bikePass: "/bike-pass/smart-system/v1/bike-passes",
	registrations: "/bike-registration/smart-system/v1/registrations",
	capacity: "/diagnosis-field-data/smart-system/v1/capacity-testers",
	updates: "/software-update/smart-system/v1/installation-reports",
	serviceV1: "/service-book/smart-system/v1/service-records",
	serviceV2: "/service-book/smart-system/v2/service-records",
} as const;

const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
const unavailable = () =>
	new ConnectionHttpError("Selected Bosch item not available", "not_found");
const incomplete = () =>
	new ConnectionHttpError(
		"Bosch history exceeds search window",
		"incomplete_history",
	);

export async function readBoschDetail(
	input: BoschDetailQuery,
	access: string,
	fetcher?: typeof fetch,
) {
	const query = parseBoschDetailQuery(input);
	if (!query || query.id === "." || query.id === "..") throw unavailable();
	const { id } = query;
	const encoded = encodeURIComponent(id);
	const get = (path: string, params?: Record<string, string>) => {
		const url = new URL(path, api);
		if (params) url.search = new URLSearchParams(params).toString();
		return getBoschPage(url, access, fetcher);
	};
	const profile = async () => {
		const bike = await get(`${routes.bikes}/${encoded}`);
		if (bike.id !== id) throw unavailable();
		return bike;
	};
	const summary = async () => {
		let offset = 0;
		for (let page = 0; page < 40; page++) {
			const result = await readBoschRidePage(access, offset, fetcher);
			const found = result.rows.find((row) => row.id === id);
			if (found) return found;
			if (result.nextOffset === null) throw unavailable();
			offset = result.nextOffset;
		}
		throw incomplete();
	};
	const stream = async () => {
		const page = await get(`${routes.rides}/${encoded}/details`);
		return { activityDetails: boschRecords(page.activityDetails) };
	};
	let source: Record<string, unknown>;
	switch (query.action) {
		case "ride_detail":
			source = await summary();
			break;
		case "ride_route":
		case "ride_stream":
			source = await stream();
			break;
		case "ride_fitness":
			// A summary-only question about calories or average cadence needs no samples.
			if (query.field?.startsWith("activityDetails")) source = await stream();
			else if (query.field) source = await summary();
			else source = { ...(await summary()), ...(await stream()) };
			break;
		case "bike_profile":
			source = await profile();
			break;
		case "bike_pass": {
			const page = await get(routes.bikePass, { bikeId: id });
			source = {
				bikePasses: boschRecords(page.bikePasses).filter(
					(row) => row.bikeId === id,
				),
			};
			break;
		}
		case "service_history": {
			let page: Record<string, unknown> | undefined;
			try {
				page = await get(routes.serviceV2, { bikeId: id });
			} catch (error) {
				if (
					!(error instanceof ConnectionHttpError) ||
					error.code !== "not_found"
				)
					throw error;
			}
			if (!page || boschRecords(page.serviceRecords).length === 0)
				page = await get(routes.serviceV1, { bikeId: id });
			source = {
				serviceRecords: boschRecords(page.serviceRecords).filter(
					(row) => object(row.attributes)?.bikeId === id,
				),
			};
			break;
		}
		case "battery_capacity": {
			const bike = await profile();
			const batteries =
				bike.batteries == null ? [] : boschRecords(bike.batteries);
			const battery = batteries[query.batteryIndex ?? 0];
			if (
				typeof battery?.partNumber !== "string" ||
				!battery.partNumber ||
				typeof battery.serialNumber !== "string" ||
				!battery.serialNumber
			)
				throw unavailable();
			const page = await get(routes.capacity, {
				partNumber: battery.partNumber,
				serialNumber: battery.serialNumber,
			});
			source = {
				capacityTesters: boschRecords(page.capacityTesters).filter((row) => {
					const data = object(row.batteryData);
					return (
						data?.partNumber === battery.partNumber &&
						data?.serialNumber === battery.serialNumber
					);
				}),
			};
			break;
		}
		case "bike_registration": {
			const bike = await profile();
			const parts = [
				bike.driveUnit,
				bike.headUnit,
				bike.remoteControl,
				bike.connectModule,
				...(Array.isArray(bike.batteries) ? bike.batteries : []),
				...(Array.isArray(bike.antiLockBrakeSystems)
					? bike.antiLockBrakeSystems
					: []),
			].map(object);
			const page = await get(routes.registrations);
			source = {
				registrations: boschRecords(page.registrations).filter((row) => {
					const bikeId = object(row.bikeRegistration)?.bikeId;
					if (bikeId != null) return bikeId === id;
					const part = object(row.componentRegistration);
					return (
						typeof part?.partNumber === "string" &&
						!!part.partNumber &&
						typeof part.serialNumber === "string" &&
						!!part.serialNumber &&
						parts.some(
							(c) =>
								c?.partNumber === part.partNumber &&
								c?.serialNumber === part.serialNumber,
						)
					);
				}),
			};
			break;
		}
		case "software_updates": {
			const installationReports: Record<string, unknown>[] = [];
			let retainedBytes = 0;
			for (let offset = 0; ; ) {
				const page = await get(routes.updates, {
					bikeId: id,
					limit: "50",
					offset: String(offset),
				});
				const reports = boschRecords(page.installationReports);
				if (reports.length > 50) throw incomplete();
				const matches = reports.filter((row) => row.bikeId === id);
				retainedBytes += Buffer.byteLength(JSON.stringify(matches));
				if (retainedBytes > 12 * 1024 * 1024) throw incomplete();
				installationReports.push(...matches);
				const projected = projectBoschDetail(query, { installationReports });
				if (projected.nextOffset !== null) return projected;
				const total = object(page.pagination)?.total;
				offset += reports.length;
				const more =
					typeof total === "number" && Number.isSafeInteger(total) && total >= 0
						? offset < total
						: reports.length === 50;
				if (!more) break;
				if (!reports.length || offset >= 2000) throw incomplete();
			}
			source = { installationReports };
			break;
		}
	}
	return projectBoschDetail(query, source);
}
