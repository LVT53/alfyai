import { beforeEach, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "../store";
import {
	gmailDraftSnapshot,
	gmailMailCount,
	gmailMailList,
	gmailReadThread,
} from "./gmail-mail";

vi.mock("./gmail", () => ({
	gmailGetAccessToken: vi.fn().mockResolvedValue("synthetic"),
	gmailCanModify: () => true,
}));
const conn = {
	id: "g",
	userId: "u",
	provider: "google",
	capabilities: ["email"],
	allowWrites: true,
	status: "connected",
} as ConnectionPublic;
const fetch = vi.fn<typeof globalThis.fetch>();
beforeEach(() => fetch.mockReset());
const json = (value: unknown) => Response.json(value);
const msg = (id: string) => ({
	id,
	threadId: "t",
	labelIds: ["INBOX"],
	internalDate: "1000",
	payload: {
		mimeType: "text/plain",
		headers: [{ name: "Subject", value: "Hello" }],
		body: { data: Buffer.from(`Body ${id}`).toString("base64url") },
	},
});
it("counts actual paginated matches and ignores Gmail's estimated result size", async () => {
	fetch
		.mockResolvedValueOnce(
			json({
				messages: [{ id: "a" }],
				resultSizeEstimate: 42,
				nextPageToken: "next",
			}),
		)
		.mockResolvedValueOnce(json({ messages: [{ id: "b" }] }));
	expect(
		await gmailMailCount(
			conn,
			{ query: "invoice", unseenOnly: true },
			{ fetch },
		),
	).toBe(2);
	const url = new URL(String(fetch.mock.calls[1][0]));
	expect(url.searchParams.get("pageToken")).toBe("next");
	expect(url.searchParams.get("labelIds")).toBe("INBOX");
	expect(url.searchParams.get("q")).toContain("is:unread");
});
it("lists opaque message ids with the thread handle using metadata only", async () => {
	fetch
		.mockResolvedValueOnce(json({ messages: [{ id: "a" }] }))
		.mockResolvedValueOnce(json(msg("a")));
	expect(await gmailMailList(conn, {}, { fetch })).toMatchObject([
		{ uid: "a", threadId: "t" },
	]);
	expect(
		new URL(String(fetch.mock.calls[1][0])).searchParams.get("format"),
	).toBe("metadata");
});
it("reads thread text through a fixed Gmail origin without inline attachment requests", async () => {
	fetch.mockResolvedValueOnce(
		json({ id: "t", messages: [msg("a"), msg("b")] }),
	);
	const result = await gmailReadThread(conn, "t", { fetch });
	expect(result.messages).toHaveLength(2);
	expect(result.text).toContain("Body b");
	expect(fetch).toHaveBeenCalledTimes(1);
	await expect(gmailReadThread(conn, "../me", { fetch })).rejects.toThrow();
});

it("counts the inbox via a single exact label lookup without scanning individual messages", async () => {
	fetch.mockResolvedValueOnce(
		json({ id: "INBOX", messagesTotal: 32000, messagesUnread: 34 }),
	);
	expect(await gmailMailCount(conn, { unseenOnly: true }, { fetch })).toBe(34);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(String(fetch.mock.calls[0][0])).toContain("/labels/INBOX");
});

it("declines a resent draft whose delivery headers cannot be represented on the confirmation", async () => {
	const m = msg("v1");
	m.labelIds = ["DRAFT"];
	m.payload.headers.push({ name: "Resent-To", value: "other@example.com" });
	fetch
		.mockResolvedValueOnce(
			json({ drafts: [{ id: "d", message: { id: m.id } }] }),
		)
		.mockResolvedValueOnce(json({ id: "d", message: m }));
	await expect(gmailDraftSnapshot(conn, m.id, { fetch })).rejects.toThrow(
		"delivery headers",
	);
	expect(fetch.mock.calls.every(([, opts]) => opts?.method === "GET")).toBe(
		true,
	);
});
