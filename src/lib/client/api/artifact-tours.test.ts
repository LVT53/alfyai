import { describe, expect, it, vi } from "vitest";
import {
	getArtifactTour,
	markArtifactTourSeen,
	seedArtifactTours,
} from "./artifact-tours";
import { ApiError } from "./http";

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const TOUR = {
	artifactType: "canvas",
	contentKey: "default:1",
	source: "default",
	slides: [
		{ title: { en: "One", hu: "Egy" }, body: { en: "a", hu: "a" } },
		{ title: { en: "Two", hu: "Kettő" }, body: { en: "b", hu: "b" } },
		{ title: { en: "Three", hu: "Három" }, body: { en: "c", hu: "c" } },
	],
	summary: { en: "Empty board.", hu: "Üres tábla." },
};

describe("getArtifactTour", () => {
	it("asks for the kind's tour and returns it with this user's state, leaving the success marker behind", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({ ok: true, tour: TOUR, seen: true, lastSlide: 1 }),
			);

		const result = await getArtifactTour("canvas", fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/artifact-tours/canvas");
		expect(result).toEqual({ tour: TOUR, seen: true, lastSlide: 1 });
		expect(result).not.toHaveProperty("ok");
	});

	it("throws an ApiError carrying the status on a failed read", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("", { status: 500 }));

		const failure = await getArtifactTour("document", fetchImpl).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(ApiError);
		expect(failure).toMatchObject({
			status: 500,
			message: "Failed to load the introduction",
		});
	});

	it("surfaces a missing session as a 401 ApiError, for the panel's own handling", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ message: "Unauthorized" }, 401));

		await expect(getArtifactTour("document", fetchImpl)).rejects.toMatchObject({
			status: 401,
			message: "Unauthorized",
		});
	});

	it("surfaces the family's 404 as an ApiError, not as a missing tour", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ ok: false, reason: "unknown_type" }, 404),
			);

		await expect(getArtifactTour("canvas", fetchImpl)).rejects.toMatchObject({
			status: 404,
		});
	});
});

describe("markArtifactTourSeen", () => {
	const payload = {
		contentKey: "default:1",
		status: "dismissed",
		lastSlide: 1,
	} as const;

	it("posts exactly the three fields to the kind's seen route", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({ ok: true, alreadyRecorded: false }),
			);

		const result = await markArtifactTourSeen("canvas", payload, fetchImpl);

		expect(result).toEqual({ ok: true, alreadyRecorded: false });
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/artifact-tours/canvas/seen");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
		expect(JSON.parse(String(init.body))).toEqual(payload);
	});

	it("reads an already-recorded answer as success", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ ok: true, alreadyRecorded: true }));

		await expect(
			markArtifactTourSeen("app", payload, fetchImpl),
		).resolves.toEqual({ ok: true, alreadyRecorded: true });
	});

	it("surfaces a 409 as an ApiError with status 409, for the panel to re-fetch on", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(
				{
					ok: false,
					reason: "content_changed",
					contentKey: "snapshot:new",
				},
				409,
			),
		);

		const failure = await markArtifactTourSeen(
			"document",
			payload,
			fetchImpl,
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).status).toBe(409);
	});

	it("falls back to a plain message on a failed write", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("", { status: 500 }));

		await expect(
			markArtifactTourSeen("document", payload, fetchImpl),
		).rejects.toMatchObject({
			status: 500,
			message: "Failed to record the introduction",
		});
	});

	it("carries the 400's field errors", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(
				{
					ok: false,
					reason: "invalid_state",
					fieldErrors: { lastSlide: "invalid" },
				},
				400,
			),
		);

		await expect(
			markArtifactTourSeen("document", payload, fetchImpl),
		).rejects.toMatchObject({
			status: 400,
			fieldErrors: { lastSlide: "invalid" },
		});
	});
});

describe("seedArtifactTours", () => {
	it("seeds the tour drafts and reports the counts", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ created: 3, existing: 0 }, 201));

		await expect(seedArtifactTours(fetchImpl)).resolves.toEqual({
			created: 3,
			existing: 0,
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/admin/campaigns/seed-artifact-tours",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("falls back to a plain message on a failed seed", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("", { status: 500 }));

		await expect(seedArtifactTours(fetchImpl)).rejects.toMatchObject({
			status: 500,
			message: "Failed to seed the tour drafts",
		});
	});
});
