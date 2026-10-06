import { expect, test } from "@playwright/test";

import { login } from "./helpers";

// The tour routes at the HTTP layer (ruling 19 names its layer): for an
// unauthenticated /api/** request hooks.server.ts answers 401 JSON before the
// route runs — requireApiUser, the route's own guard, is pinned in the route's
// unit test — and a request with a session reaches the route. Everything here
// is a READ or a refused write: the e2e user is shared by every spec of a run,
// so a spec that marked a tour seen would change what a later spec sees.
test.describe("Artifact tour routes, no session", () => {
	test("GET /api/artifact-tours/[type] answers 401 JSON, not a redirect", async ({
		request,
	}) => {
		const response = await request.get("/api/artifact-tours/document", {
			maxRedirects: 0,
		});

		expect(response.status()).toBe(401);
		expect(response.headers()["content-type"]).toContain("application/json");
		expect(response.headers()["x-session-expired"]).toBe("1");
		expect(await response.json()).toMatchObject({ code: "session_expired" });
	});

	test("POST /api/artifact-tours/[type]/seen answers 401 JSON, not a redirect", async ({
		request,
	}) => {
		const response = await request.post("/api/artifact-tours/document/seen", {
			data: { contentKey: "default:1", status: "completed", lastSlide: 2 },
			maxRedirects: 0,
		});

		expect(response.status()).toBe(401);
		expect(response.headers()["content-type"]).toContain("application/json");
		expect(response.headers()["x-session-expired"]).toBe("1");
		expect(await response.json()).toMatchObject({ code: "session_expired" });
	});
});

test.describe("Artifact tour routes, signed in", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("serves a three-slide tour in both languages for each of the three shipped kinds", async ({
		page,
	}) => {
		for (const type of ["document", "app", "canvas"]) {
			const response = await page.request.get(`/api/artifact-tours/${type}`);
			expect(response.status(), type).toBe(200);
			const body = await response.json();
			expect(body.ok, type).toBe(true);
			expect(body.tour.artifactType, type).toBe(type);
			expect(body.tour.contentKey, type).toMatch(/^(default|snapshot):/);
			expect(body.tour.slides, type).toHaveLength(3);
			for (const slide of body.tour.slides) {
				expect(slide.title.en).toBeTruthy();
				expect(slide.title.hu).toBeTruthy();
				expect(slide.body.en).toBeTruthy();
				expect(slide.body.hu).toBeTruthy();
			}
			expect(body.tour.summary.en).toBeTruthy();
			expect(body.tour.summary.hu).toBeTruthy();
			expect(typeof body.seen).toBe("boolean");
			expect(Number.isInteger(body.lastSlide)).toBe(true);
		}
	});

	test("is a 404 for Slides (shelved), File and anything else, on both routes", async ({
		page,
	}) => {
		for (const type of ["slides", "file", "bogus"]) {
			const read = await page.request.get(`/api/artifact-tours/${type}`);
			expect(read.status(), `GET ${type}`).toBe(404);
			expect(await read.json()).toEqual({ ok: false, reason: "unknown_type" });

			const write = await page.request.post(
				`/api/artifact-tours/${type}/seen`,
				{
					data: { contentKey: "default:1", status: "completed", lastSlide: 2 },
				},
			);
			expect(write.status(), `POST ${type}`).toBe(404);
			expect(await write.json()).toEqual({ ok: false, reason: "unknown_type" });
		}
	});

	test("refuses a malformed write with the field it did not like", async ({
		page,
	}) => {
		const response = await page.request.post("/api/artifact-tours/app/seen", {
			data: { contentKey: "default:1", status: "seen", lastSlide: 7 },
		});

		expect(response.status()).toBe(400);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "invalid_state",
			fieldErrors: { status: "invalid", lastSlide: "invalid" },
		});
	});

	test("refuses a write for content that is not the current tour, and names the current key", async ({
		page,
	}) => {
		const current = await (
			await page.request.get("/api/artifact-tours/canvas")
		).json();

		const response = await page.request.post(
			"/api/artifact-tours/canvas/seen",
			{
				data: {
					contentKey: "snapshot:an-older-publish",
					status: "completed",
					lastSlide: 2,
				},
			},
		);

		expect(response.status()).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "content_changed",
			contentKey: current.tour.contentKey,
		});
	});

	test("the version badge's endpoint never answers with a tour", async ({
		page,
	}) => {
		const response = await page.request.get("/api/campaigns/latest");

		expect(response.status()).toBe(200);
		const body = await response.json();
		expect(body.campaign?.type ?? "release_update").not.toBe("artifact_tour");
	});
});
