import { expect, it, vi } from "vitest";
import { readBoschDetail } from "./bosch-flow-detail-reader";

it("reads only the selected profile and returns the documented component values", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({
			id: "bike-1",
			batteries: [{ serialNumber: "series-1" }],
			secret: "unexpected",
		}),
	);
	const result = await readBoschDetail(
		{ action: "bike_profile", id: "bike-1" },
		"access",
		fetch,
	);
	expect(result.fields).toContainEqual({
		path: "batteries.0.serialNumber",
		value: "series-1",
	});
	expect(JSON.stringify(result)).not.toContain("unexpected");
	expect(String(fetch.mock.calls[0][0])).toBe(
		"https://api.bosch-ebike.com/bike-profile/smart-system/v1/bikes/bike-1",
	);
});
it("binds bike passes to the requested bike and refuses a mismatched profile", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async (u) =>
		String(u).includes("bike-passes")
			? Response.json({
					bikePasses: [
						{ bikeId: "other", frameNumber: "unrelated" },
						{ bikeId: "bike-1", frameNumber: "mine" },
					],
				})
			: Response.json({ id: "other" }),
	);
	const result = await readBoschDetail(
		{ action: "bike_pass", id: "bike-1" },
		"access",
		fetch,
	);
	expect(JSON.stringify(result)).toContain("mine");
	expect(JSON.stringify(result)).not.toContain("unrelated");
	await expect(
		readBoschDetail({ action: "bike_profile", id: "bike-1" }, "access", fetch),
	).rejects.toThrow();
});
it("stops on service book permission denial and falls back to v1 when v2 is empty", async () => {
	const blocked = vi.fn<typeof globalThis.fetch>(
		async () => new Response(null, { status: 403 }),
	);
	await expect(
		readBoschDetail(
			{ action: "service_history", id: "mine" },
			"access",
			blocked,
		),
	).rejects.toThrow();
	expect(blocked).toHaveBeenCalledTimes(1);
	const fetch = vi.fn<typeof globalThis.fetch>(async (u) =>
		Response.json({
			serviceRecords: String(u).includes("/v2/")
				? []
				: [{ attributes: { bikeId: "mine", odometerValue: 5000 } }],
		}),
	);
	const result = await readBoschDetail(
		{ action: "service_history", id: "mine" },
		"access",
		fetch,
	);
	expect(result.fields).toContainEqual({
		path: "serviceRecords.0.attributes.odometerValue",
		value: 5000,
	});
	expect(fetch).toHaveBeenCalledTimes(2);
});
it("finds a selected ride summary without fetching GPS and separates sampled route from fitness", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async (u) =>
		String(u).includes("/details")
			? Response.json({
					activityDetails: [
						{
							distance: 20,
							latitude: 47,
							longitude: 19,
							speed: 12,
							cadence: 60,
							riderPower: 130,
						},
					],
				})
			: Response.json({
					activitySummaries: [
						{
							id: "ride",
							distance: 1500,
							riderPower: { average: 100 },
							caloriesBurned: 120,
						},
					],
					pagination: { total: 1 },
				}),
	);
	const summary = await readBoschDetail(
		{ action: "ride_detail", id: "ride" },
		"access",
		fetch,
	);
	expect(summary.fields).toContainEqual({ path: "distance", value: 1500 });
	expect(JSON.stringify(summary)).not.toMatch(
		/riderPower|caloriesBurned|latitude/,
	);
	expect(fetch).toHaveBeenCalledTimes(1);
	const route = await readBoschDetail(
		{ action: "ride_route", id: "ride" },
		"access",
		fetch,
	);
	expect(route.fields).toContainEqual({
		path: "activityDetails.0.latitude",
		value: 47,
	});
	expect(JSON.stringify(route)).not.toMatch(/cadence|riderPower/);
	const fitness = await readBoschDetail(
		{ action: "ride_fitness", id: "ride" },
		"access",
		fetch,
	);
	expect(JSON.stringify(fitness)).toContain("riderPower");
	expect(JSON.stringify(fitness)).not.toMatch(/latitude|longitude/);
});

it("selects registrations and battery tests from the chosen bike and never accepts an unrelated part", async () => {
	const bike = {
		id: "mine",
		batteries: [
			{ partNumber: "A&1", serialNumber: "selected" },
			{ partNumber: "B", serialNumber: "second" },
		],
	};
	const fetch = vi.fn<typeof globalThis.fetch>(async (u) => {
		const url = new URL(String(u));
		if (url.pathname.endsWith("/bikes/mine")) return Response.json(bike);
		if (url.pathname.endsWith("/registrations"))
			return Response.json({
				registrations: [
					{
						bikeRegistration: { bikeId: "mine" },
						registrationType: "BIKE_REGISTRATION",
					},
					{
						componentRegistration: { partNumber: "B", serialNumber: "second" },
						registrationType: "COMPONENT_REGISTRATION",
					},
					{
						componentRegistration: {
							partNumber: "unrelated",
							serialNumber: "second",
						},
					},
					{ bikeRegistration: { bikeId: "other" } },
				],
			});
		expect(url.searchParams.get("partNumber")).toBe("B");
		expect(url.searchParams.get("serialNumber")).toBe("second");
		return Response.json({
			capacityTesters: [
				{
					batteryData: {
						partNumber: "B",
						serialNumber: "second",
						measuredCapacity: 600,
					},
				},
				{
					batteryData: {
						partNumber: "foreign",
						serialNumber: "second",
						measuredCapacity: 999,
					},
				},
			],
		});
	});
	const regs = await readBoschDetail(
		{ action: "bike_registration", id: "mine" },
		"access",
		fetch,
	);
	expect(JSON.stringify(regs)).toContain("COMPONENT_REGISTRATION");
	expect(JSON.stringify(regs)).not.toMatch(/unrelated|other/);
	const result = await readBoschDetail(
		{ action: "battery_capacity", id: "mine", batteryIndex: 1 },
		"access",
		fetch,
	);
	expect(result.fields).toContainEqual({
		path: "capacityTesters.0.batteryData.measuredCapacity",
		value: 600,
	});
	expect(JSON.stringify(result)).not.toContain("999");
});

it("keeps software installation reports scoped to the selected bike across labelled pages", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async (u) => {
		const url = new URL(String(u));
		expect(url.searchParams.get("bikeId")).toBe("mine");
		const offset = url.searchParams.get("offset");
		return Response.json({
			installationReports: [
				{
					bikeId: offset === "0" ? "other" : "mine",
					createdAt: offset === "0" ? "private" : "2026-09-01",
				},
			],
			pagination: { total: 2 },
		});
	});
	const updates = await readBoschDetail(
		{ action: "software_updates", id: "mine" },
		"access",
		fetch,
	);
	expect(updates.fields).toContainEqual({
		path: "installationReports.0.createdAt",
		value: "2026-09-01",
	});
	expect(JSON.stringify(updates)).not.toContain("private");
	expect(fetch).toHaveBeenCalledTimes(2);
});

it("refuses dot segments without contacting Bosch", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>();
	await expect(
		readBoschDetail({ action: "ride_route", id: ".." }, "access", fetch),
	).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
});
