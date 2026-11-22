import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/image-search", () => ({
	fetchPublisherThumbnail: vi.fn(),
}));

import { fetchPublisherThumbnail } from "$lib/server/services/image-search";
import {
	noteMessageSources,
	noteToolEntrySources,
	resetUrlProvenanceForTests,
} from "$lib/server/services/url-provenance";
import {
	IMAGE_THUMBNAIL_ROUTE,
	imageThumbnailRouteUrl,
} from "$lib/shared/url-provenance";
import { GET } from "./+server";

// The signed-in route authorizes the original in a recorded search result.
const THUMB = "https://images.example.com/cat.jpg";
const SAVED_ALIAS = "https://archive.example.com/thumbnail/abc";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const fetchThumbnailMock = vi.mocked(fetchPublisherThumbnail);
type ThumbnailEvent = Parameters<typeof GET>[0];

function eventFor(
	address: string | null,
	user: { id: string } | null = { id: "user-1" },
): ThumbnailEvent {
	const query = address === null ? "" : `?url=${encodeURIComponent(address)}`;
	const url = `http://localhost/api/image-search/thumbnail${query}`;
	return {
		url: new URL(url),
		request: new Request(url),
		locals: { user },
	} as unknown as ThumbnailEvent;
}

function listThumbnail(userId = "user-1", thumbnail = SAVED_ALIAS) {
	noteToolEntrySources(userId, {
		name: "image_search",
		input: { query: "cat" },
		status: "done",
		candidates: [
			{
				id: "c1",
				title: "Cat",
				url: THUMB,
				sourceType: "web",
				metadata: { thumbnail },
			},
		],
	});
}

describe("GET /api/image-search/thumbnail", () => {
	beforeEach(() => {
		resetUrlProvenanceForTests();
		fetchThumbnailMock.mockReset();
		fetchThumbnailMock.mockResolvedValue({
			bytes: PNG,
			contentType: "image/png",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function expectNotFound(response: Response) {
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
		expect(response.headers.get("cache-control")).toBe("no-store");
	}

	it("is the route the shared contract names, asked the way the page asks it", async () => {
		// The page builds the address with `imageThumbnailRouteUrl` and the server
		// reads it here: the two must name the same route and the same parameter.
		expect(
			existsSync(
				resolve(process.cwd(), `src/routes${IMAGE_THUMBNAIL_ROUTE}/+server.ts`),
			),
		).toBe(true);
		listThumbnail();
		const asked = new URL(imageThumbnailRouteUrl(THUMB), "http://localhost");

		const response = await GET({
			url: asked,
			request: new Request(asked),
			locals: { user: { id: "user-1" } },
		} as unknown as ThumbnailEvent);

		expect(response.status).toBe(200);
		expect(fetchThumbnailMock).toHaveBeenCalledWith(THUMB);
	});

	it("serves the thumbnail a search returned to this user, from this origin, as an inert image", async () => {
		listThumbnail();

		const response = await GET(eventFor(THUMB));

		expect(fetchThumbnailMock).toHaveBeenCalledTimes(1);
		expect(fetchThumbnailMock).toHaveBeenCalledWith(THUMB);
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		// A second account in this browser must make its own authenticated request.
		expect(response.headers.get("vary")).toBe("Cookie");
		expect(response.headers.get("cache-control")).toBe(
			"private, max-age=86400",
		);
		expect(response.headers.get("content-security-policy")).toBe(
			"default-src 'none'; sandbox",
		);
		expect(response.headers.get("cross-origin-resource-policy")).toBe(
			"same-origin",
		);
	});

	it("says which of the raster types it is serving", async () => {
		listThumbnail();
		for (const contentType of [
			"image/jpeg",
			"image/png",
			"image/webp",
			"image/gif",
			"image/avif",
		] as const) {
			fetchThumbnailMock.mockResolvedValueOnce({ bytes: PNG, contentType });

			const response = await GET(eventFor(THUMB));

			expect(response.headers.get("content-type"), contentType).toBe(
				contentType,
			);
		}
	});

	it("rejects saved thumbnail aliases and forged addresses even when a stored result names them as thumbnail metadata", async () => {
		const others = [
			SAVED_ALIAS,
			"https://evil.example/collect?d=secret",
			"/api/image-search/thumbnail?url=x",
			"javascript:alert(1)",
			"",
		];
		for (const other of others) listThumbnail("user-1", other);

		for (const other of others) {
			await expectNotFound(await GET(eventFor(other)));
		}
		await expectNotFound(await GET(eventFor(null)));
		expect(fetchThumbnailMock).not.toHaveBeenCalled();
	});

	it("never fetches a variation on the original publisher address", async () => {
		listThumbnail();
		const forged = THUMB.replace("cat.jpg", "dog.jpg");

		await expectNotFound(await GET(eventFor(forged)));
		await expectNotFound(await GET(eventFor(`${THUMB}?x=1`)));
		await expectNotFound(await GET(eventFor(`${THUMB}/`)));
		expect(fetchThumbnailMock).not.toHaveBeenCalled();
	});

	it("serves the address a search returned whatever fragment the page adds", async () => {
		listThumbnail();

		const response = await GET(eventFor(`${THUMB}#ignored`));

		expect(response.status).toBe(200);
		expect(fetchThumbnailMock).toHaveBeenCalledTimes(1);
	});

	it("does not serve a thumbnail another user's search returned", async () => {
		listThumbnail("user-2");

		await expectNotFound(await GET(eventFor(THUMB, { id: "user-1" })));
		expect(fetchThumbnailMock).not.toHaveBeenCalled();
	});

	it("serves only the exact publisher image returned to this user after a conversation reload", async () => {
		const image = "https://www.example.com/cat.jpg?size=large";
		vi.mocked(fetchPublisherThumbnail).mockResolvedValue({
			bytes: PNG,
			contentType: "image/png",
		});
		noteMessageSources("user-1", [
			{
				role: "assistant",
				thinkingSegments: [
					{
						type: "tool_call",
						name: "image_search",
						input: {},
						status: "done",
						candidates: [
							{
								id: "cat",
								sourceType: "web",
								title: "Cat",
								url: image,
								metadata: { provider: "parallel", thumbnail: image },
							},
						],
					},
				],
			},
		]);
		await expectNotFound(await GET(eventFor(image, { id: "other" })));
		await expectNotFound(await GET(eventFor(image.replace("www.", ""))));
		await expectNotFound(await GET(eventFor(image.replace("large", "small"))));
		expect(fetchPublisherThumbnail).not.toHaveBeenCalled();
		expect((await GET(eventFor(image))).status).toBe(200);
		expect(fetchPublisherThumbnail).toHaveBeenCalledExactlyOnceWith(image);
	});

	it("is refused without a session", async () => {
		listThumbnail();

		await expect(GET(eventFor(THUMB, null))).rejects.toMatchObject({
			status: 401,
		});
		expect(fetchThumbnailMock).not.toHaveBeenCalled();
	});

	it("is a bare 404 when the fetch gave nothing to serve", async () => {
		listThumbnail();
		fetchThumbnailMock.mockResolvedValueOnce(null);

		await expectNotFound(await GET(eventFor(THUMB)));
	});

	it("is a bare 404, and logs no address, even if the fetch were ever to throw", async () => {
		const logs = [
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(console, "info").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(console, "error").mockImplementation(() => {}),
		];
		listThumbnail();
		fetchThumbnailMock.mockRejectedValueOnce(new Error(`failed ${THUMB}`));

		await expectNotFound(await GET(eventFor(THUMB)));
		await expectNotFound(
			await GET(eventFor("https://evil.example/collect?d=secret")),
		);

		for (const log of logs) {
			expect(JSON.stringify(log.mock.calls)).not.toContain(THUMB);
			expect(JSON.stringify(log.mock.calls)).not.toContain("evil");
		}
	});
});
