import { describe, expect, it, vi } from "vitest";
import {
	anotherImageTake,
	imageFileUrl,
	retryImageTake,
	stopImageTake,
	useImageTake,
} from "./images";

function ok(body: unknown = {}, status = 200) {
	return vi.fn(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	);
}

describe("imageFileUrl", () => {
	it("builds the file URL with its options", () => {
		expect(imageFileUrl("f1")).toBe("/api/images/files/f1");
		expect(imageFileUrl("f1", { variant: "thumb", conversationId: "c1" })).toBe(
			"/api/images/files/f1?variant=thumb&conversationId=c1",
		);
		expect(imageFileUrl("f1", { download: true })).toBe(
			"/api/images/files/f1?download=1",
		);
	});
});

describe("image card actions", () => {
	it("posts Use this and answers the version number", async () => {
		const fetchMock = ok({ versionNumber: 3 });
		await expect(useImageTake("t1", "c1", fetchMock)).resolves.toEqual({
			versionNumber: 3,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/images/takes/t1/use?conversationId=c1",
			{ method: "POST" },
		);
	});

	it("posts Another and answers the take id", async () => {
		const fetchMock = ok({ takeId: "t9" }, 201);
		await expect(anotherImageTake("card1", null, fetchMock)).resolves.toEqual({
			takeId: "t9",
		});
		expect(fetchMock).toHaveBeenCalledWith("/api/images/cards/card1/another", {
			method: "POST",
		});
	});

	it("posts Stop and Try again", async () => {
		const stop = ok({ ok: true });
		await stopImageTake("t1", undefined, stop);
		expect(stop).toHaveBeenCalledWith("/api/images/takes/t1/stop", {
			method: "POST",
		});
		const retry = ok({ ok: true });
		await retryImageTake("t1", "c1", retry);
		expect(retry).toHaveBeenCalledWith(
			"/api/images/takes/t1/retry?conversationId=c1",
			{ method: "POST" },
		);
	});

	it("throws when the server refuses", async () => {
		const refused = ok({ error: "not_ready" }, 409);
		await expect(useImageTake("t1", null, refused)).rejects.toThrow();
	});
});
