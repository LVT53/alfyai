import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchBody = vi.fn();
vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifactVersionBody: (...args: unknown[]) => fetchBody(...args),
}));

import { versionBody } from "./version-bodies";

// Stepping through History's rail must not ask the server for the same stored
// body twice, and the newest row (which a typing burst saves into) is the one
// body that is asked for again when its hash moved.

let artifact = 0;
beforeEach(() => {
	fetchBody.mockReset();
	artifact += 1;
});

function request(versionId: string, nowHash = "h1") {
	return {
		artifactId: `art-${artifact}`,
		versionId,
		conversationId: null,
		nowVersionId: "v9",
		nowHash,
	};
}

describe("a stored version's body", () => {
	it("is fetched once however many times a preview asks for it", async () => {
		fetchBody.mockResolvedValue("body of v1");
		await versionBody(request("v1"));
		await versionBody(request("v1"));
		expect(fetchBody).toHaveBeenCalledTimes(1);
		expect(fetchBody).toHaveBeenCalledWith(`art-${artifact}`, "v1", null);
	});

	it("is fetched again for the newest version only when its hash moved", async () => {
		fetchBody.mockResolvedValue("newest");
		await versionBody(request("v9", "h1"));
		await versionBody(request("v9", "h1"));
		expect(fetchBody).toHaveBeenCalledTimes(1);
		await versionBody(request("v9", "h2"));
		expect(fetchBody).toHaveBeenCalledTimes(2);
	});

	it("keeps a failure for no longer than the failed ask", async () => {
		fetchBody.mockRejectedValueOnce(new Error("offline"));
		await expect(versionBody(request("v2"))).rejects.toThrow("offline");
		fetchBody.mockResolvedValueOnce("now fine");
		await expect(versionBody(request("v2"))).resolves.toBe("now fine");
	});

	it("keeps an incognito chat's body apart from the same id read outside it", async () => {
		fetchBody.mockResolvedValue("x");
		await versionBody({ ...request("v3"), conversationId: "c1" });
		await versionBody(request("v3"));
		expect(fetchBody).toHaveBeenCalledTimes(2);
	});

	it("is a small memory: the oldest goes first, the one just used stays", async () => {
		fetchBody.mockResolvedValue("x");
		for (let index = 0; index < 16; index += 1) {
			await versionBody(request(`old-${index}`));
		}
		// Use the first again, so it is no longer the oldest...
		await versionBody(request("old-0"));
		// ...then push one more in: old-1 is the one dropped.
		await versionBody(request("fresh"));
		fetchBody.mockClear();
		await versionBody(request("old-0"));
		expect(fetchBody).not.toHaveBeenCalled();
		await versionBody(request("old-1"));
		expect(fetchBody).toHaveBeenCalledTimes(1);
	});
});
