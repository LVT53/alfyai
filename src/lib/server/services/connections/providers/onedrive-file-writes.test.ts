import { describe, expect, it, vi } from "vitest";
import { microsoftGraphRequest } from "./microsoft-graph";

describe("Microsoft account Graph requests", () => {
	it("only sends credentials to the account endpoint and refuses redirects", async () => {
		const fetch = vi.fn().mockResolvedValue(Response.json({}));
		await microsoftGraphRequest("token", "GET", "/me/drive/root", { fetch });
		expect(fetch).toHaveBeenCalledWith(
			"https://graph.microsoft.com/v1.0/me/drive/root",
			expect.objectContaining({ redirect: "error" }),
		);
		for (const invalid of [
			"https://example.com/me",
			"//example.com/me",
			"/me/../users",
			"/me/%2e%2e/users",
		]) {
			await expect(
				microsoftGraphRequest("token", "GET", invalid, { fetch }),
			).rejects.toThrow();
		}
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

import { prepareOneDriveFileWrite } from "./onedrive-file-writes";

it("prepares an overwrite against the exact file version and uses only reads before confirmation", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValue(Response.json({ id: "original", eTag: "v1", file: {} }));
	const { op, content } = await prepareOneDriveFileWrite(
		"conn",
		["/Work"],
		"token",
		{ action: "save", path: "/Work/report.txt", content: "updated" },
		{ fetch },
	);
	expect(op.destructive).toBe(true);
	expect(op.target).toMatchObject({
		path: "/Work/report.txt",
		id: "original",
		etag: "v1",
	});
	expect(content).toBe("updated");
	expect(fetch.mock.calls.every(([, init]) => init.method === "GET")).toBe(
		true,
	);
});

import { oneDriveDocumentUrl } from "$lib/shared/onedrive-links";
import { executeOneDriveFileWrite } from "./onedrive-file-writes";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../store")>()),
	getConnection: connection,
}));
vi.mock("./onedrive", async (importOriginal) => ({
	...(await importOriginal<typeof import("./onedrive")>()),
	onedriveGetAccessTokenForRead: vi.fn(async () => "token"),
}));

const file = { id: "src", file: {}, eTag: "v1" };
const folder = { id: "dir", folder: {}, eTag: "d1" };
function graphFixture(source: typeof file | null = file) {
	const items = new Map<string, typeof file | typeof folder>([
		["/me/drive/root", folder],
	]);
	if (source) items.set("/me/drive/root:/old.txt", source);
	const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(url)).pathname.replace("/v1.0", "");
		if (init?.method === "GET")
			return items.has(path)
				? Response.json(items.get(path))
				: new Response(null, { status: 404 });
		if (path.endsWith("/createLink"))
			return Response.json({ link: { webUrl: "https://1drv.ms/example" } });
		return new Response(null, { status: 204 });
	});
	connection.mockResolvedValue({
		provider: "onedrive",
		allowWrites: true,
		capabilities: ["files"],
		oauthScopes: ["Files.ReadWrite"],
	});
	return { items, fetch };
}

it.each([
	["save", "/new.txt", "PUT", "/me/drive/items/dir:/new.txt:/content"],
	["save", "/old.txt", "PUT", "/me/drive/items/src/content"],
	["move", "/old.txt", "PATCH", "/me/drive/items/src"],
	["delete", "/old.txt", "DELETE", "/me/drive/items/src"],
	["create_folder", "/New", "POST", "/me/drive/items/dir/children"],
	["share_link", "/old.txt", "POST", "/me/drive/items/src/createLink"],
])(
	"confirms %s for %s against the captured account item",
	async (action, path, method, endpoint) => {
		const { fetch } = graphFixture();
		const { op, content } = await prepareOneDriveFileWrite(
			"c",
			[],
			"token",
			{ action, path, destinationPath: "/new.txt", content: "hello" },
			{ fetch },
		);
		expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
			true,
		);
		const result = await executeOneDriveFileWrite("u", "c", op, content, {
			fetch,
		});
		expect(result.ok).toBe(true);
		const writes = fetch.mock.calls.filter(
			([, init]) => init?.method !== "GET",
		);
		expect(writes).toHaveLength(1);
		const [url, init] = writes[0];
		expect(new URL(String(url)).pathname).toBe(`/v1.0${endpoint}`);
		expect(init?.method).toBe(method);
		if (path === "/old.txt")
			expect(new Headers(init?.headers).get("if-match")).toBe("v1");
		if (action === "save" && path === "/new.txt") {
			expect(
				new URL(String(url)).searchParams.get(
					"@microsoft.graph.conflictBehavior",
				),
			).toBe("fail");
			expect(new Headers(init?.headers).get("if-none-match")).toBe("*");
		}
		if (action === "move")
			expect(JSON.parse(String(init?.body))).toEqual({
				name: "new.txt",
				parentReference: { id: "dir" },
			});
		if (action === "create_folder")
			expect(JSON.parse(String(init?.body))).toEqual({
				name: "New",
				folder: {},
				"@microsoft.graph.conflictBehavior": "fail",
			});
		if (action === "share_link") {
			expect(result).toMatchObject({ resultUrl: "https://1drv.ms/example" });
			expect(JSON.parse(String(init?.body))).toEqual({
				type: "view",
				scope: "anonymous",
			});
		}
	},
);

it("retains a changed file and refuses a grant revoked after the proposal", async () => {
	const { items, fetch } = graphFixture();
	const { op, content } = await prepareOneDriveFileWrite(
		"c",
		[],
		"token",
		{ action: "delete", path: "/old.txt" },
		{ fetch },
	);
	items.set("/me/drive/root:/old.txt", { ...file, eTag: "v2" });
	expect(
		await executeOneDriveFileWrite("u", "c", op, content, { fetch }),
	).toMatchObject({ ok: false, reason: "item_changed" });
	connection.mockResolvedValue({
		provider: "onedrive",
		allowWrites: true,
		capabilities: ["files"],
		oauthScopes: ["Files.Read"],
	});
	expect(
		await executeOneDriveFileWrite("u", "c", op, content, { fetch }),
	).toMatchObject({ ok: false, reason: "writes_disabled" });
	expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
		true,
	);
});
it("refuses links outside OneDrive and organization SharePoint", () => {
	for (const url of [
		"javascript:alert(1)",
		"https://onedrive.live.com.example.com/x",
		"https://me@foo.sharepoint.com/x",
		"http://1drv.ms/foo",
	])
		expect(oneDriveDocumentUrl(url)).toBeUndefined();
});
