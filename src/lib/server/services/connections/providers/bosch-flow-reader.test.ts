import { describe, expect, it, vi } from "vitest";
import {
	readBoschFlowBikes,
	readBoschFlowRides,
	summarizeBoschFlowRides,
} from "./bosch-flow-reader";

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
	it("counts each ride once across pages, with local midnight and missing distances", async () => {
		const before = {
			id: "old",
			startTime: "2026-10-31T21:59:59Z",
			distance: 50,
		};
		const first = {
			id: "start",
			startTime: "2026-11-01T00:00:00+02:00",
			distance: 2200,
		};
		const last = { id: "later", startTime: "2026-11-15T06:10:00Z" };
		const boundary = {
			id: "end",
			startTime: "2026-12-01T00:00:00+02:00",
			distance: 100,
		};
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					activitySummaries: [first, before],
					pagination: { total: 5 },
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					activitySummaries: [first, last, boundary],
					pagination: { total: 5 },
				}),
			);
		expect(
			await summarizeBoschFlowRides(
				"test",
				new Date("2026-11-01T00:00:00+02:00"),
				new Date("2026-12-01T00:00:00+02:00"),
				fetchImpl,
			),
		).toEqual({
			rideCount: 2,
			measuredDistanceMeters: 2200,
			ridesWithoutDistance: 1,
			complete: true,
		});
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
