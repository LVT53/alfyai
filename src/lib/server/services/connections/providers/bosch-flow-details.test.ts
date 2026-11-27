import { describe, expect, it } from "vitest";
import {
	parseBoschDetailQuery,
	parseBoschDetailResult,
	projectBoschDetail,
	requiredBoschGrant,
} from "./bosch-flow-details";

describe("Bosch detail projections", () => {
	it("keeps location and fitness separate even when Bosch supplies them together", () => {
		const mixed = {
			activityDetails: [
				{
					distance: 201.5,
					speed: 15.4,
					altitude: 230,
					latitude: 42,
					longitude: 26,
					cadence: 91,
					riderPower: 211,
					unknownToken: "private",
				},
			],
		};
		for (const [action, grant, keys] of [
			["ride_stream", "details", ["altitude", "distance", "speed"]],
			["ride_route", "location", ["distance", "latitude", "longitude"]],
			["ride_fitness", "fitness", ["cadence", "distance", "riderPower"]],
		] as const) {
			const q = { action, id: "selected" };
			expect(requiredBoschGrant(q)).toBe(grant);
			const projected = projectBoschDetail(q, mixed);
			expect(projected.fields.map((f) => f.path)).toEqual(
				keys.map((k) => `activityDetails.0.${k}`),
			);
			expect(parseBoschDetailResult(q, projected)).toEqual(projected);
			expect(
				parseBoschDetailResult(q, {
					...projected,
					fields: [{ path: "activityDetails.0.unknownToken", value: "x" }],
				}),
			).toBeNull();
		}
	});
	it("allows only approved field prefixes and a selected component, including arrays", () => {
		const source = {
			batteries: [
				{ chargeCycles: { onBike: 15 }, serialNumber: "private-device" },
			],
			driveUnit: {
				activeAssistModes: [{ name: "eco", reachableRange: 48195 }],
			},
		};
		const q = {
			action: "bike_profile",
			id: "s",
			field: "batteries.0.chargeCycles",
		} as const;
		expect(parseBoschDetailQuery(q)).toEqual(q);
		const res = projectBoschDetail(q, source);
		expect(res).toEqual({
			fields: [{ path: "batteries.0.chargeCycles.onBike", value: 15 }],
			nextOffset: null,
		});
		expect(
			parseBoschDetailResult(q, {
				fields: [{ path: "batteries.0.serialNumber", value: "serial" }],
				nextOffset: null,
			}),
		).toBeNull();
		expect(parseBoschDetailQuery({ ...q, field: "__proto__" })).toBeNull();
		expect(
			parseBoschDetailQuery({ ...q, field: "batteries.0.accessToken" }),
		).toBeNull();
		expect(parseBoschDetailQuery({ ...q, id: "../rider" })).toBeNull();
	});
	it("pages rather than silently discarding later points, and flags clipped free text", () => {
		const activityDetails = Array.from({ length: 70 }, (_, i) => ({
			latitude: 30 + i / 100,
			longitude: 20 + i / 100,
		}));
		const q = { action: "ride_route", id: "r" } as const;
		const first = projectBoschDetail(q, { activityDetails });
		expect(first.nextOffset).toBe(first.fields.length);
		const second = projectBoschDetail(
			{ ...q, offset: first.nextOffset ?? 0 },
			{ activityDetails },
		);
		expect(
			new Set([...first.fields, ...second.fields].map((f) => f.path)).size,
		).toBe(first.fields.length + second.fields.length);
		const pass = projectBoschDetail(
			{ action: "bike_pass", id: "b" },
			{ bikePasses: [{ description: "x".repeat(1700) }] },
		);
		expect(pass.fields[0]).toMatchObject({ nextTextOffset: 1024 });
		const continued = {
			action: "bike_pass",
			id: "b",
			field: "bikePasses.0.description",
			textOffset: 1024,
		} as const;
		expect(parseBoschDetailQuery(continued)).toEqual(continued);
		const rest = projectBoschDetail(continued, {
			bikePasses: [{ description: "x".repeat(1700) }],
		});
		expect(rest.fields).toEqual([
			{ path: "bikePasses.0.description", value: "x".repeat(676) },
		]);
		expect(parseBoschDetailResult(continued, rest)).toEqual(rest);
		expect(
			parseBoschDetailQuery({ ...continued, field: "bikePasses" }),
		).toBeNull();
	});
});
