import { beforeEach, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "../store";
import { getConnection } from "../store";
import {
	executeTeamsChannelFileWrite,
	openChannelFiles,
	prepareTeamsFileWrite,
} from "./teams-channel-files";

vi.mock("../store", () => ({ getConnection: vi.fn() }));
vi.mock("./onedrive", async (original) => ({
	...(await original<typeof import("./onedrive")>()),
	onedriveGetAccessTokenForRead: vi.fn(async () => "token"),
}));
vi.mock("$lib/shared/microsoft-permissions", async (original) => ({
	...(await original<typeof import("$lib/shared/microsoft-permissions")>()),
	microsoftCanWrite: () => true,
}));
const team = "11111111-1111-4111-8111-111111111111",
	channel = "19:testing@thread.tacv2";
const folder = {
	id: "ROOT",
	name: "General",
	folder: {},
	webUrl: "https://tenant.sharepoint.com/sites/Team/Shared%20Documents/General",
	parentReference: { driveId: "drive-1" },
};
const file = {
	id: "ITEM",
	name: "report.txt",
	file: { mimeType: "text/plain" },
	eTag: '"v1"',
	size: 2,
	webUrl: `${folder.webUrl}/report.txt`,
	parentReference: { id: "ROOT", driveId: "drive-1" },
};
const fetch = vi.fn<typeof globalThis.fetch>(),
	download = vi.fn<typeof globalThis.fetch>();
const ref = { teamId: team, channelId: channel },
	conn = {
		id: "c",
		userId: "u",
		provider: "onedrive",
		status: "connected",
		capabilities: ["teams_files"],
		allowWrites: true,
		writeAllowlist: [],
	} as unknown as ConnectionPublic;
beforeEach(() => {
	fetch.mockReset();
	download.mockReset();
	vi.mocked(getConnection).mockResolvedValue(conn);
});
it("opens the selected channel's filesFolder before listing children below its returned root", async () => {
	fetch
		.mockResolvedValueOnce(Response.json(folder))
		.mockResolvedValueOnce(Response.json({ value: [file] }));
	const opened = await openChannelFiles(conn, ref, { fetch, download });
	expect(await opened.list("/")).toMatchObject([
		{ path: "/report.txt", name: "report.txt" },
	]);
	expect(String(fetch.mock.calls[0][0])).toContain("/filesFolder");
	expect(String(fetch.mock.calls[1][0])).toContain(
		"/drives/drive-1/items/ROOT/children",
	);
});
it("rejects mismatched parents and channel-escaping paths without following them", async () => {
	fetch.mockResolvedValueOnce(Response.json(folder)).mockResolvedValueOnce(
		Response.json({
			value: [
				{ ...file, parentReference: { id: "outside", driveId: "other" } },
			],
		}),
	);
	const opened = await openChannelFiles(conn, ref, { fetch, download });
	await expect(opened.stat("/%2e%2e/Secret")).rejects.toThrow();
	await expect(opened.list("/")).rejects.toThrow();
	expect(fetch).toHaveBeenCalledTimes(2);
});
it("downloads bytes from the channel tenant only and never gives the preauthenticated URL a Graph bearer", async () => {
	const trusted =
		"https://tenant.sharepoint.com/sites/Team/_layouts/15/download.aspx?key=synthetic";
	fetch
		.mockResolvedValueOnce(Response.json(folder))
		.mockResolvedValueOnce(Response.json(file))
		.mockResolvedValueOnce(
			new Response(null, { status: 302, headers: { location: trusted } }),
		);
	download.mockResolvedValueOnce(new Response("ok"));
	const opened = await openChannelFiles(conn, ref, { fetch, download });
	const result = await opened.read("/report.txt");
	expect(Buffer.from(result.bytes).toString()).toBe("ok");
	expect(download).toHaveBeenCalledTimes(1);
	expect(
		new Headers(download.mock.calls[0][1]?.headers).has("authorization"),
	).toBe(false);
});
it("holds a captured channel write when its filesFolder has been replaced", async () => {
	fetch
		.mockResolvedValueOnce(Response.json(folder))
		.mockResolvedValueOnce(Response.json(file));
	const opened = await openChannelFiles(conn, ref, { fetch, download });
	const { op, content } = await prepareTeamsFileWrite(conn, opened, {
		action: "delete",
		path: "/report.txt",
	});
	fetch.mockResolvedValueOnce(Response.json({ ...folder, id: "NEW" }));
	expect(
		await executeTeamsChannelFileWrite("u", "c", op, content, { fetch }),
	).toMatchObject({ ok: false, reason: "destination_changed" });
	expect(
		fetch.mock.calls.every(
			([, init]) => !init?.method || init.method === "GET",
		),
	).toBe(true);
});
it("rejects bounded download cards after the original item or revision changes", async () => {
	fetch
		.mockResolvedValueOnce(Response.json(folder))
		.mockResolvedValueOnce(Response.json({ ...file, eTag: '"v2"' }));
	const opened = await openChannelFiles(conn, ref, { fetch, download });
	await expect(
		opened.read("/report.txt", { id: file.id, revision: file.eTag }),
	).rejects.toThrow();
	expect(download).not.toHaveBeenCalled();
	expect(fetch).toHaveBeenCalledTimes(2);
});
it("shares a view link only inside the signed-in organization", async () => {
	fetch
		.mockResolvedValueOnce(Response.json(folder))
		.mockResolvedValueOnce(Response.json(file));
	const opened = await openChannelFiles(conn, ref, { fetch, download });
	const { op, content, preview } = await prepareTeamsFileWrite(conn, opened, {
		action: "share_link",
		path: "/report.txt",
	});
	expect(preview.warnings.join(" ")).toMatch(/organization/);
	fetch
		.mockResolvedValueOnce(Response.json(folder))
		.mockResolvedValueOnce(Response.json(file))
		.mockResolvedValueOnce(
			Response.json({
				link: {
					scope: "organization",
					type: "view",
					webUrl: `${folder.webUrl}/report.txt`,
				},
			}),
		);
	expect(
		await executeTeamsChannelFileWrite("u", "c", op, content, { fetch }),
	).toMatchObject({ ok: true });
	expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({
		type: "view",
		scope: "organization",
	});
});
it.each([false, true])(
	"uses the confirmed selected attachment bytes and refuses a changed version (changed=%s)",
	async (changed) => {
		const source = {
			id: "selected-id",
			name: "clip.png",
			sha256: "a".repeat(64),
			size: 3,
			contentType: "image/png",
		};
		const matching = { source, bytes: new Uint8Array([0, 255, 16]) };
		const resolver = vi.spyOn(
			await import("./teams-upload-source"),
			"teamsUploadSource",
		);
		resolver
			.mockResolvedValueOnce(matching)
			.mockResolvedValueOnce(
				changed
					? { ...matching, source: { ...source, sha256: "b".repeat(64) } }
					: matching,
			);
		try {
			fetch
				.mockResolvedValueOnce(Response.json(folder))
				.mockResolvedValueOnce(new Response(null, { status: 404 }));
			const opened = await openChannelFiles(conn, ref, { fetch, download });
			const { op, content } = await prepareTeamsFileWrite(
				conn,
				opened,
				{ action: "save", path: "/clip.png", sourceId: "selected" },
				["selected-id"],
			);
			expect(op.target?.uploadSource).toEqual(source);
			expect(content).toBe("");
			expect(resolver).toHaveBeenCalledWith("u", "selected", ["selected-id"]);
			fetch
				.mockResolvedValueOnce(Response.json(folder))
				.mockResolvedValueOnce(new Response(null, { status: 404 }));
			if (!changed)
				fetch.mockResolvedValueOnce(
					Response.json({ ...file, name: "clip.png" }),
				);
			const result = await executeTeamsChannelFileWrite("u", "c", op, content, {
				fetch,
			});
			if (changed) {
				expect(result).toMatchObject({ ok: false, reason: "item_changed" });
				expect(
					fetch.mock.calls.filter(([, opts]) => opts?.method === "PUT"),
				).toHaveLength(0);
			} else {
				expect(result.ok).toBe(true);
				const [url, opts] = fetch.mock.calls.at(-1) ?? [];
				expect(String(url)).toContain(
					"/drives/drive-1/items/ROOT:/clip.png:/content",
				);
				expect([...new Uint8Array(opts?.body as ArrayBuffer)]).toEqual([
					0, 255, 16,
				]);
				expect(new Headers(opts?.headers).get("If-None-Match")).toBe("*");
			}
		} finally {
			resolver.mockRestore();
		}
	},
);
it("uses only a same-folder cursor and retains the rooted URL when paging", async () => {
	fetch
		.mockResolvedValueOnce(Response.json(folder))
		.mockResolvedValueOnce(
			Response.json({
				value: [file],
				"@odata.nextLink":
					"https://graph.microsoft.com/v1.0/drives/drive-1/items/ROOT/children?%24skiptoken=two",
			}),
		)
		.mockResolvedValueOnce(
			Response.json({ value: [{ ...file, id: "f2", name: "50% #2.txt" }] }),
		);
	const channel = await openChannelFiles(conn, ref, { fetch });
	expect((await channel.list("/")).map((x) => x.name)).toEqual([
		"report.txt",
		"50% #2.txt",
	]);
	expect(
		new URL(String(fetch.mock.calls[2][0])).searchParams.get("$skiptoken"),
	).toBe("two");
});
