import { beforeEach, expect, it, vi } from "vitest";
import type { WriteOperation } from "../write-guard";
import {
	executeGoogleDriveWrite,
	prepareDriveFileWrite,
} from "./google-drive-writes";

vi.mock("./google-drive-auth", () => ({
	googleDriveCanModify: () => true,
	googleDriveGetAccessToken: async () => "token",
}));
vi.mock("../store", () => ({
	getConnection: async () => ({
		id: "c",
		userId: "u",
		provider: "google",
		status: "connected",
		allowWrites: true,
		capabilities: ["files"],
	}),
}));
const fetch = vi.fn<typeof globalThis.fetch>();
const opts = { fetch };
const item = {
	id: "f",
	name: "report",
	mimeType: "text/plain",
	version: "5",
	parents: ["p"],
	capabilities: { canShare: true, canEdit: true, canTrash: true },
};
const original = {
	provider: "google",
	connectionId: "c",
	action: "files.share_link",
	target: { id: "f", path: "/@drive/f", etag: "5", label: "report" },
	destructive: false,
	reversible: true,
	summary: "share",
} satisfies WriteOperation;
beforeEach(() => fetch.mockReset());
it("refuses Workspace content replacement before proposing a write", async () => {
	fetch.mockResolvedValueOnce(
		Response.json({
			...item,
			mimeType: "application/vnd.google-apps.document",
		}),
	);
	await expect(
		prepareDriveFileWrite(
			"c",
			[],
			"token",
			{ action: "save", path: "/@drive/f", content: "a" },
			opts,
		),
	).rejects.toThrow(/Workspace/);
});
it("revalidates the item version at confirmation before modifying its permissions", async () => {
	fetch.mockResolvedValueOnce(Response.json({ ...item, version: "6" }));
	expect(
		await executeGoogleDriveWrite("u", "c", original, "", opts),
	).toMatchObject({ ok: false, reason: "item_changed" });
	expect(fetch.mock.calls).toHaveLength(1);
});
it("creates a non-discoverable viewer permission only; returns the checked Drive URL", async () => {
	fetch.mockResolvedValueOnce(Response.json(item));
	fetch.mockResolvedValueOnce(Response.json({ permissions: [] }));
	fetch.mockResolvedValueOnce(
		Response.json({
			id: "anyoneWithLink",
			type: "anyone",
			role: "reader",
			allowFileDiscovery: false,
		}),
	);
	expect(
		await executeGoogleDriveWrite("u", "c", original, "", opts),
	).toMatchObject({
		ok: true,
		resultUrl: "https://drive.google.com/file/d/f/view",
	});
	const [u, init] = fetch.mock.calls[2];
	expect(String(u)).toContain("/files/f/permissions");
	expect(JSON.parse(String(init?.body))).toEqual({
		type: "anyone",
		role: "reader",
		allowFileDiscovery: false,
	});
});
it("does not broaden or bypass an organization sharing restriction", async () => {
	fetch
		.mockResolvedValueOnce(Response.json(item))
		.mockResolvedValueOnce(Response.json({ permissions: [] }))
		.mockResolvedValueOnce(new Response(null, { status: 403 }));
	expect(
		await executeGoogleDriveWrite("u", "c", original, "", opts),
	).toMatchObject({ ok: false });
	expect(fetch).toHaveBeenCalledTimes(3);
});
it("requires a verified HTTP ETag for replacing bytes and leaves a conflicting revision untouched", async () => {
	fetch
		.mockResolvedValueOnce(Response.json(item))
		.mockResolvedValueOnce(
			Response.json({ id: item.id, version: item.version, etag: '"rev-five"' }),
		)
		.mockResolvedValueOnce(new Response(null, { status: 412 }));
	expect(
		await executeGoogleDriveWrite(
			"u",
			"c",
			{ ...original, action: "files.put", destructive: true },
			"new text",
			opts,
		),
	).toMatchObject({ ok: false, reason: "item_changed" });
	const [url, init] = fetch.mock.calls[2];
	expect(String(url)).toContain("upload/drive/v2/files/f");
	expect(init?.method).toBe("PUT");
	expect(new Headers(init?.headers).get("If-Match")).toBe('"rev-five"');
	expect(init?.body).toBe("new text");
});
it("sets the trash flag and never permanently deletes a file", async () => {
	fetch
		.mockResolvedValueOnce(Response.json(item))
		.mockResolvedValueOnce(
			Response.json({ id: item.id, version: item.version, etag: '"safe"' }),
		)
		.mockResolvedValueOnce(Response.json({ id: item.id }));
	expect(
		await executeGoogleDriveWrite(
			"u",
			"c",
			{ ...original, action: "files.delete" },
			"",
			opts,
		),
	).toEqual({ ok: true });
	const init = fetch.mock.calls[2][1];
	expect(init?.method).toBe("PATCH");
	expect(JSON.parse(String(init?.body))).toMatchObject({
		labels: { trashed: true },
	});
});
it("refuses to move over a new collision even when the captured source remains unchanged", async () => {
	fetch
		.mockResolvedValueOnce(Response.json(item))
		.mockResolvedValueOnce(
			Response.json({ files: [{ ...item, id: "other" }] }),
		);
	expect(
		await executeGoogleDriveWrite(
			"u",
			"c",
			{
				...original,
				action: "files.move",
				target: { ...original.target, path: "/Report", parentId: "p" },
			},
			JSON.stringify({ fromPath: "/@drive/f", toPath: "/Report" }),
			opts,
		),
	).toMatchObject({ ok: false, reason: "destination_exists" });
	expect(
		fetch.mock.calls.every(
			([, init]) => !init?.method || init.method === "GET",
		),
	).toBe(true);
});
it.each(["save", "create_folder"])(
	"reserves a stable create ID for %s and submits it only after confirmation",
	async (action) => {
		const root = {
			id: "rootreal",
			name: "My Drive",
			mimeType: "application/vnd.google-apps.folder",
			version: "1",
		};
		fetch
			.mockResolvedValueOnce(Response.json({ files: [] }))
			.mockResolvedValueOnce(Response.json(root))
			.mockResolvedValueOnce(Response.json({ ids: ["reserved"] }));
		const proposed = await prepareDriveFileWrite(
			"c",
			[],
			"token",
			{
				action,
				path: "/Budget",
				content: action === "save" ? "draft text" : undefined,
			},
			opts,
		);
		expect(proposed.op.target?.generatedId).toBe("reserved");
		fetch
			.mockResolvedValueOnce(Response.json({ files: [] }))
			.mockResolvedValueOnce(Response.json(root))
			.mockResolvedValueOnce(Response.json({ id: "reserved" }));
		expect(
			await executeGoogleDriveWrite(
				"u",
				"c",
				proposed.op,
				proposed.content,
				opts,
			),
		).toEqual({ ok: true });
		const [, mutation] = fetch.mock.calls[5];
		expect(mutation?.method).toBe("POST");
		expect(mutation?.body).toContain('"id":"reserved"');
		if (action === "save") expect(mutation?.body).toContain("draft text");
	},
);
