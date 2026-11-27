import { beforeEach, expect, it, vi } from "vitest";
import { openChannelFiles } from "$lib/server/services/connections/providers/teams-channel-files";
import { getConnection } from "$lib/server/services/connections/store";
import { GET } from "./+server";

vi.mock("$lib/server/services/connections/store", () => ({
	getConnection: vi.fn(),
}));
vi.mock(
	"$lib/server/services/connections/providers/teams-channel-files",
	() => ({ openChannelFiles: vi.fn() }),
);
const url = new URL(
	"https://local.test/api/connections/teams/files/download?connectionId=c&teamId=t&channelId=k&itemId=i&revision=r&path=%2Fa.bin",
);
const event = (user?: { id: string }) =>
	({ url, locals: { user } }) as Parameters<typeof GET>[0];
beforeEach(() => vi.resetAllMocks());
it("requires an authenticated owner with this connection's Teams Files service", async () => {
	expect((await GET(event())).status).toBe(401);
	expect(getConnection).not.toHaveBeenCalled();
	vi.mocked(getConnection).mockResolvedValue(null);
	expect((await GET(event({ id: "other" }))).status).toBe(404);
	expect(getConnection).toHaveBeenCalledWith("other", "c");
	expect(openChannelFiles).not.toHaveBeenCalled();
});
it("serves the pinned file bytes as a private attachment without returning the SharePoint download URL", async () => {
	vi.mocked(getConnection).mockResolvedValue({
		provider: "onedrive",
		status: "connected",
		capabilities: ["teams_files"],
	} as NonNullable<Awaited<ReturnType<typeof getConnection>>>);
	const read = vi
		.fn()
		.mockResolvedValue({
			bytes: new Uint8Array([0, 255]),
			name: "a.bin",
			contentType: "application/octet-stream",
		});
	vi.mocked(openChannelFiles).mockResolvedValue({ read } as unknown as Awaited<
		ReturnType<typeof openChannelFiles>
	>);
	const result = await GET(event({ id: "owner" }));
	expect(result.status).toBe(200);
	expect(read).toHaveBeenCalledWith("/a.bin", { id: "i", revision: "r" });
	expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([0, 255]);
	expect(result.headers.get("Content-Disposition")).toContain("attachment;");
	expect(result.headers.get("Cache-Control")).toContain("no-store");
});
