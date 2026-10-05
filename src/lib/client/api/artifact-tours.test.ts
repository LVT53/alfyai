import { afterEach, describe, expect, it, vi } from "vitest";
import { getArtifactTour, markArtifactTourSeen } from "./artifact-tours";
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

// One answer per kind per page load (RC-T Minor 11): what the server said about
// a kind is kept by the module, so a reader who opens a dozen Documents is asked
// once, and the answer an item needs is in hand before it opens. Each test loads
// a module of its own: the memory is the page's, and a new test is a new page.
describe("the answer kept for a page load", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function pageLoad(
		answers: Array<{ seen: boolean; tour?: typeof TOUR } | "fail">,
	) {
		const fetchStub = vi.fn();
		for (const answer of answers) {
			fetchStub.mockImplementationOnce(async () =>
				answer === "fail"
					? new Response("", { status: 500 })
					: jsonResponse({
							ok: true,
							tour: answer.tour ?? TOUR,
							seen: answer.seen,
							lastSlide: 0,
						}),
			);
		}
		fetchStub.mockImplementation(async () =>
			jsonResponse({ ok: true, alreadyRecorded: false }),
		);
		vi.stubGlobal("fetch", fetchStub);
		vi.resetModules();
		const module = await import("./artifact-tours");
		return { ...module, fetchStub };
	}

	const reads = (fetchStub: ReturnType<typeof vi.fn>) =>
		fetchStub.mock.calls.filter(
			([, init]) => (init as RequestInit | undefined)?.method !== "POST",
		);

	it("asks for a kind once, and shares the answer while it is still on the wire", async () => {
		const { getArtifactTour, fetchStub } = await pageLoad([{ seen: false }]);

		const first = getArtifactTour("canvas");
		const second = getArtifactTour("canvas");
		const [one, two] = await Promise.all([first, second]);

		expect(one).toEqual({ tour: TOUR, seen: false, lastSlide: 0 });
		expect(two).toBe(one);
		await getArtifactTour("canvas");
		expect(reads(fetchStub)).toHaveLength(1);
	});

	it("keeps each kind apart", async () => {
		const { getArtifactTour, fetchStub } = await pageLoad([
			{ seen: false },
			{ seen: true },
		]);

		await getArtifactTour("canvas");
		await getArtifactTour("document");
		await getArtifactTour("canvas");
		await getArtifactTour("document");

		expect(reads(fetchStub).map(([url]) => url)).toEqual([
			"/api/artifact-tours/canvas",
			"/api/artifact-tours/document",
		]);
	});

	it("does not keep a failure: the next ask goes to the server again", async () => {
		const { getArtifactTour, fetchStub } = await pageLoad([
			"fail",
			{ seen: false },
		]);

		await expect(getArtifactTour("document")).rejects.toMatchObject({
			status: 500,
		});
		await expect(getArtifactTour("document")).resolves.toMatchObject({
			seen: false,
		});
		expect(reads(fetchStub)).toHaveLength(2);
	});

	it("asks again for a replay, and keeps the copy it brought back", async () => {
		const newer = { ...TOUR, contentKey: "snapshot:new" };
		const { getArtifactTour, refreshArtifactTour, fetchStub } = await pageLoad([
			{ seen: true },
			{ seen: false, tour: newer },
		]);

		await getArtifactTour("canvas");
		const refreshed = await refreshArtifactTour("canvas");

		expect(refreshed.tour.contentKey).toBe("snapshot:new");
		expect((await getArtifactTour("canvas")).tour.contentKey).toBe(
			"snapshot:new",
		);
		expect(reads(fetchStub)).toHaveLength(2);
	});

	it("takes a finished tour as seen at once, before the server has answered", async () => {
		const { getArtifactTour, markArtifactTourSeen, fetchStub } = await pageLoad(
			[{ seen: false }],
		);
		await getArtifactTour("document");
		fetchStub.mockImplementationOnce(() => new Promise(() => {}));

		void markArtifactTourSeen("document", {
			contentKey: TOUR.contentKey,
			status: "completed",
			lastSlide: 2,
		});

		await expect(getArtifactTour("document")).resolves.toMatchObject({
			seen: true,
			lastSlide: 2,
		});
	});

	it("leaves a different copy unseen: only what was read is marked", async () => {
		const { getArtifactTour, markArtifactTourSeen } = await pageLoad([
			{ seen: false },
		]);
		await getArtifactTour("document");

		await markArtifactTourSeen("document", {
			contentKey: "default:0",
			status: "dismissed",
			lastSlide: 0,
		});

		await expect(getArtifactTour("document")).resolves.toMatchObject({
			seen: false,
		});
	});

	it("forgets the kind when the write is refused or fails, so the next ask is the server's", async () => {
		const { getArtifactTour, markArtifactTourSeen, fetchStub } = await pageLoad(
			[{ seen: false }],
		);
		await getArtifactTour("document");
		fetchStub.mockImplementationOnce(async () =>
			jsonResponse({ ok: false, reason: "content_changed" }, 409),
		);

		await expect(
			markArtifactTourSeen("document", {
				contentKey: TOUR.contentKey,
				status: "completed",
				lastSlide: 2,
			}),
		).rejects.toMatchObject({ status: 409 });

		fetchStub.mockImplementationOnce(async () =>
			jsonResponse({ ok: true, tour: TOUR, seen: false, lastSlide: 0 }),
		);
		await expect(getArtifactTour("document")).resolves.toMatchObject({
			seen: false,
		});
		expect(reads(fetchStub)).toHaveLength(2);
	});

	it("keeps nothing for a fetch it was handed", async () => {
		const { getArtifactTour } = await pageLoad([]);
		const handed = vi
			.fn()
			.mockImplementation(async () =>
				jsonResponse({ ok: true, tour: TOUR, seen: false, lastSlide: 0 }),
			);

		await getArtifactTour("canvas", handed);
		await getArtifactTour("canvas", handed);

		expect(handed).toHaveBeenCalledTimes(2);
	});
});
