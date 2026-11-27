import { describe, expect, it, vi } from "vitest";
import {
	driveList,
	driveRead,
	driveResolve,
	driveSearch,
} from "./google-drive-files";

const item = (
	id: string,
	name: string,
	kind = "document",
	extra: Record<string, unknown> = {},
) => ({
	id,
	name,
	mimeType: `application/vnd.google-apps.${kind}`,
	version: "12",
	parents: ["rootid"],
	...extra,
});
const opts = (...responses: unknown[]) => ({
	fetch: vi.fn<typeof globalThis.fetch>(async () => {
		const v = responses.shift();
		if (v instanceof Response) return v;
		if (v === undefined) throw new Error("unexpected Google call");
		return Response.json(v);
	}),
});
describe("Drive v3", () => {
	it("rejects duplicate names even when a second match is on the next page", async () => {
		const a = item("one", "Budget"),
			b = item("two", "Budget");
		const o = opts({ files: [a], nextPageToken: "p2" }, { files: [b] });
		await expect(driveResolve("token", "/Budget", o)).rejects.toThrow(
			/more than one|ambiguous/i,
		);
	});
	it("reads Workspace document text by exact id without following a server-provided download URL", async () => {
		const a = item("one", "Notes", "document", {
			webContentLink: "https://outside.invalid/tracker",
		});
		const o = opts(a, new Response("hello"));
		const res = await driveRead("token", "/@drive/one", o);
		expect(new TextDecoder().decode(res.bytes)).toBe("hello");
		expect(String(o.fetch.mock.calls.at(-1)?.[0])).toContain(
			"/files/one/export?",
		);
		expect(o.fetch.mock.calls.at(-1)?.[1]).toMatchObject({ redirect: "error" });
	});
	it("lists two same-name files with distinct selectable handles and Google links", async () => {
		const o = opts({ files: [item("one", "Tuesday"), item("two", "Tuesday")] });
		const result = await driveList("token", "/", o);
		expect(result.map((r) => r.path)).toEqual(["/@drive/one", "/@drive/two"]);
		expect(result[0].webUrl).toContain("one");
	});
	it("escapes a literal search term and keeps all requests on the Drive API", async () => {
		const o = opts({ files: [] });
		await driveSearch("token", "d'Ana", o);
		const u = new URL(String(o.fetch.mock.calls[0][0]));
		expect(u.hostname).toBe("www.googleapis.com");
		expect(u.searchParams.get("q")).toContain("d\\'Ana");
	});
});
