import { describe, expect, it, vi } from "vitest";
import { readBoschFlowBikes, readBoschFlowRides } from "./bosch-flow-reader";

describe("Bosch Flow authorized ride data", () => {
	it("only returns the requested summary fields and continues from the number received", async () => {
		const request = vi.fn(async () =>
			Response.json({
				activitySummaries: [
					{
						id: "ride",
						distance: 1400,
						track: ["private route"],
						startTime: "2026-11-01T10:00:00Z",
					},
				],
				pagination: { total: 53 },
			}),
		);
		const result = await readBoschFlowRides("token", 50, request);
		expect(result).toEqual({
			rides: [
				{
					id: "ride",
					distanceMeters: 1400,
					startTime: "2026-11-01T10:00:00Z",
					endTime: null,
				},
			],
			nextOffset: 51,
		});
		expect(request).toHaveBeenCalledWith(
			expect.stringContaining("offset=50"),
			expect.objectContaining({
				redirect: "error",
				headers: expect.objectContaining({ Authorization: "Bearer token" }),
			}),
		);
	});
	it("reports incomplete coverage if the provider omits an expected page", async () => {
		await expect(
			readBoschFlowRides("token", 50, async () =>
				Response.json({ activitySummaries: [], pagination: { total: 60 } }),
			),
		).rejects.toMatchObject({ code: "incomplete_history" });
	});
	it("distinguishes an empty bike list from a denied or malformed response", async () => {
		await expect(
			readBoschFlowBikes("token", async () => Response.json({ bikes: [] })),
		).resolves.toEqual([]);
		await expect(
			readBoschFlowBikes("token", async () => Response.json({})),
		).rejects.toMatchObject({ code: "invalid_response" });
		await expect(
			readBoschFlowBikes(
				"token",
				async () => new Response(null, { status: 403 }),
			),
		).rejects.toMatchObject({ code: "access_denied" });
	});
});
it("refuses oversized provider data before deserializing a ride history", async () => {
	const fetch = vi.fn(
		async () =>
			new Response("{}", { headers: { "Content-Length": "1000000000" } }),
	);
	await expect(readBoschFlowRides("access", 0, fetch)).rejects.toMatchObject({
		code: "response_too_large",
	});
});
