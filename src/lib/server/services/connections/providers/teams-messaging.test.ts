import { beforeEach, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "../store";
import { getConnection } from "../store";
import type { WriteOperation } from "../write-guard";
import { onedriveGetAccessTokenForRead } from "./onedrive";
import { teamsChannelFilesFolder } from "./teams-graph";
import {
	executeTeamsWrite,
	type TeamsInput,
	teamsDestination,
	teamsRead,
	teamsRoute,
} from "./teams-messaging";

vi.mock("./onedrive", () => ({ onedriveGetAccessTokenForRead: vi.fn() }));
vi.mock("../store", () => ({ getConnection: vi.fn() }));
const conn: ConnectionPublic = {
	id: "c",
	userId: "u",
	provider: "onedrive",
	label: "Work",
	accountIdentifier: "example@invalid.test",
	status: "connected",
	statusDetail: null,
	defaultOn: true,
	allowWrites: true,
	writeAllowlist: [],
	capabilities: ["teams_chat", "teams_channels"],
	config: { microsoftOrganizationAccount: true },
	oauthScopes: [
		"Chat.Read",
		"ChatMessage.Send",
		"ChannelMessage.Read.All",
		"ChannelMessage.Send",
		"Team.ReadBasic.All",
		"Channel.ReadBasic.All",
	],
	tokenExpiresAt: null,
	hasSecret: true,
	hasWriteSecret: false,
	createdAt: 0,
	updatedAt: 0,
};
const channel = { teamId: "team", channelId: "19:channel@thread.tacv2" };
const root = "https://graph.microsoft.com/v1.0";
const base = "/teams/team/channels/19%3Achannel%40thread.tacv2";
function pages(...responses: unknown[]) {
	const fetch = vi.fn<typeof globalThis.fetch>();
	for (const response of responses)
		fetch.mockResolvedValueOnce(Response.json(response));
	return fetch;
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(onedriveGetAccessTokenForRead).mockResolvedValue("test");
	vi.mocked(getConnection).mockResolvedValue(conn);
});
it("lists a second page in the same chat and emits plain text and Teams message links", async () => {
	const path = "/chats/19%3Achat%40thread.v2/messages";
	const fetch = pages(
		{
			value: [{ id: "deleted", deletedDateTime: "today" }],
			"@odata.nextLink": `${root + path}?$skiptoken=2`,
		},
		{
			value: [
				{
					id: "m",
					body: { contentType: "html", content: "<p>Hey &amp; hi</p>" },
					from: { user: { displayName: "Alice" } },
					webUrl: "https://teams.microsoft.com/l/message/chat/m",
				},
				{ id: "n", webUrl: "https://example.test/not-a-citation" },
			],
		},
	);
	const result = await teamsRead(
		conn,
		{ action: "list_messages", chatId: "19:chat@thread.v2" },
		"teams_chat",
		{ fetch },
	);
	expect(result.items).toMatchObject([
		{
			label: "Alice",
			body: "Hey & hi\n",
			url: "https://teams.microsoft.com/l/message/chat/m",
		},
		{ url: "" },
	]);
	expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([
	"https://example.test/random",
	`${root}/chats/other/messages?$skiptoken=2`,
	`${root}/chats/C/messages?x=other`,
])("does not send the bearer to a mismatched continuation", async (next) => {
	const fetch = pages({ value: [], "@odata.nextLink": next });
	await expect(
		teamsRead(conn, { action: "list_messages", chatId: "C" }, "teams_chat", {
			fetch,
		}),
	).rejects.toThrow("continuation");
	expect(fetch).toHaveBeenCalledTimes(1);
});
it("only permits directory operations for the channel files capability", async () => {
	const fetch = pages({ value: [] });
	await teamsRead(
		conn,
		{ action: "list_channels", teamId: "team" },
		"teams_files",
		{ fetch },
	);
	await expect(
		teamsRead(conn, { action: "list_messages", ...channel }, "teams_files", {
			fetch,
		}),
	).rejects.toThrow();
	expect(fetch).toHaveBeenCalledTimes(1);
});
it("shows both team and channel names and the exact parent before proposing a reply", async () => {
	const fetch = pages(
		{ id: channel.channelId, displayName: "General" },
		{
			id: "p",
			body: { contentType: "text", content: "Discuss?" },
			from: { user: { displayName: "Alex" } },
		},
		{ id: "team", displayName: "Design" },
	);
	expect(
		await teamsDestination(
			conn,
			{ action: "reply", ...channel, messageId: "p", body: "Agreed" },
			{ fetch },
		),
	).toEqual({ destination: "Design / General", original: "Alex · Discuss?" });
	expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual([
		root + base,
		`${root + base}/messages/p`,
		`${root}/teams/team`,
	]);
});
const actions: [TeamsInput, string, unknown, number][] = [
	[
		{ action: "send", chatId: "chat", body: "<text>" },
		"/chats/chat/messages",
		{ body: { contentType: "text", content: "<text>" } },
		201,
	],
	[
		{ action: "reply", ...channel, messageId: "p", body: "Reply" },
		`${base}/messages/p/replies`,
		{ body: { contentType: "text", content: "Reply" } },
		201,
	],
	[
		{
			action: "set_reaction",
			...channel,
			messageId: "p",
			replyId: "r",
			reaction: "👍",
		},
		`${base}/messages/p/replies/r/setReaction`,
		{ reactionType: "👍" },
		204,
	],
	[
		{
			action: "remove_reaction",
			chatId: "chat",
			messageId: "p",
			reaction: "👍",
		},
		"/chats/chat/messages/p/unsetReaction",
		{ reactionType: "👍" },
		204,
	],
];
function op(i: TeamsInput): WriteOperation {
	return {
		action: `teams.${i.action}`,
		provider: "onedrive",
		connectionId: "c",
		target: { id: teamsRoute(i).path },
		reversible: false,
		destructive: false,
		summary: "test",
	};
}
it.each(actions)(
	"confirms a bound Teams mutation (%j)",
	async (i, path, body, status) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response(null, { status }));
		expect(
			await executeTeamsWrite("u", "c", op(i), JSON.stringify(i), { fetch }),
		).toEqual({ ok: true });
		expect(fetch).toHaveBeenCalledWith(
			root + path,
			expect.objectContaining({
				method: "POST",
				redirect: "error",
				body: JSON.stringify(body),
			}),
		);
		expect(getConnection).toHaveBeenCalledWith("u", "c");
	},
);
it("refuses a changed target or disabled write and never retries an uncertain send", async () => {
	const [i] = actions[0];
	const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(Error());
	expect(
		await executeTeamsWrite(
			"u",
			"c",
			{ ...op(i), target: { id: "another" } },
			JSON.stringify(i),
			{ fetch },
		),
	).toMatchObject({ ok: false });
	vi.mocked(getConnection).mockResolvedValueOnce({
		...conn,
		allowWrites: false,
	});
	expect(
		await executeTeamsWrite("u", "c", op(i), JSON.stringify(i), { fetch }),
	).toEqual({ ok: false, reason: "writes_not_allowed" });
	expect(fetch).not.toHaveBeenCalled();
	expect(
		await executeTeamsWrite("u", "c", op(i), JSON.stringify(i), { fetch }),
	).toEqual({ ok: false, reason: "may_not_have_gone_through" });
	expect(fetch).toHaveBeenCalledTimes(1);
});
it("fetches only the chosen channel folder, rejecting untrusted path fragments", async () => {
	const fetch = pages({});
	await teamsChannelFilesFolder("token", channel.teamId, channel.channelId, {
		fetch,
	});
	expect(fetch).toHaveBeenCalledWith(
		`${root + base}/filesFolder`,
		expect.objectContaining({ method: "GET", redirect: "error" }),
	);
	expect(() =>
		teamsChannelFilesFolder("token", "..", channel.channelId, { fetch }),
	).toThrow();
	expect(() =>
		teamsChannelFilesFolder("token", "team", "c%2Fmessages", { fetch }),
	).toThrow();
});
