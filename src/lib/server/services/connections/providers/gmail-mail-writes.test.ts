import { beforeEach, expect, it, vi } from "vitest";
import { type ConnectionPublic, getConnection } from "../store";
import type { WriteOperation } from "../write-guard";
import { gmailCanModify } from "./gmail";
import { executeGmailMailWrite } from "./gmail-mail-writes";

vi.mock("../store", () => ({ getConnection: vi.fn() }));
vi.mock("./gmail", () => ({
	gmailGetAccessToken: vi.fn().mockResolvedValue("synthetic"),
	gmailCanModify: vi.fn(),
}));
const account = {
	provider: "google",
	capabilities: ["email"],
	accountIdentifier: "person@example.com",
	allowWrites: true,
	status: "connected",
} as ConnectionPublic;
const fetch = vi.fn<typeof globalThis.fetch>();
const run = (action: string, data: Record<string, unknown>, target?: string) =>
	executeGmailMailWrite(
		"user",
		"acct",
		{
			provider: "google",
			connectionId: "acct",
			action,
			summary: "test",
			reversible: false,
			destructive: false,
			target: { id: target ?? "", label: "test" },
		} satisfies WriteOperation,
		JSON.stringify(data),
		{ fetch },
	);
beforeEach(() => {
	fetch.mockReset();
	vi.mocked(getConnection).mockResolvedValue(account);
	vi.mocked(gmailCanModify).mockReturnValue(true);
});
it("sends MIME only to confirmed addresses; Unicode text and literal newlines stay in the body", async () => {
	fetch.mockResolvedValueOnce(Response.json({ id: "sent" }));
	expect(
		await run("email.send", {
			to: "Alice <alice@example.com>",
			cc: "bob@example.com",
			subject: "Meeting",
			body: "hello\nBcc: eve@example.com",
		}),
	).toEqual({ ok: true });
	const raw = Buffer.from(
		JSON.parse(String(fetch.mock.calls[0][1]?.body)).raw,
		"base64url",
	).toString();
	expect(raw).toContain("To: Alice <alice@example.com>");
	expect(raw).toContain("Cc: bob@example.com");
	expect(raw.split("\r\n\r\n")[0]).not.toContain("Bcc:");
	expect(String(fetch.mock.calls[0][0])).toContain("/messages/send");
	expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects injected headers or scope withdrawal before any Gmail write", async () => {
	expect(
		(
			await run("email.send", {
				to: "a@example.com\r\nBcc: b@example.com",
				subject: "Test",
				body: "Text",
			})
		).ok,
	).toBe(false);
	vi.mocked(gmailCanModify).mockReturnValue(false);
	expect(await run("email.trash", { uid: "m" }, "m")).toMatchObject({
		ok: false,
		reason: "writes_not_allowed",
	});
	expect(fetch).not.toHaveBeenCalled();
});
it("uses trash instead of deletion and translates seen=true into removal of UNREAD", async () => {
	fetch.mockImplementation(async () => Response.json({ id: "m" }));
	expect((await run("email.trash", { uid: "m" }, "m")).ok).toBe(true);
	expect(String(fetch.mock.calls[0][0])).toContain("messages/m/trash");
	expect(
		(await run("email.flag", { uid: "m", flag: "seen", value: true }, "m")).ok,
	).toBe(true);
	expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({
		removeLabelIds: ["UNREAD"],
	});
});
it("blocks a renamed Gmail label and a changed or missing saved draft", async () => {
	fetch.mockResolvedValueOnce(
		Response.json({
			labels: [{ id: "Label_2", name: "Changed", type: "user" }],
		}),
	);
	expect(
		await run(
			"email.label",
			{ uid: "m", labelId: "Label_2", labelName: "Original", value: true },
			"m",
		),
	).toMatchObject({ ok: false, reason: "target_changed" });
	fetch.mockResolvedValueOnce(
		Response.json({ drafts: [{ id: "d", message: { id: "replacement" } }] }),
	);
	expect((await run("email.send_draft", { uid: "m", etag: "m" }, "m")).ok).toBe(
		false,
	);
	expect(fetch.mock.calls.every(([, opts]) => opts?.method === "GET")).toBe(
		true,
	);
});
it("keeps a confirmed response timeout uncertain without repeating the send", async () => {
	fetch.mockRejectedValueOnce(new TypeError("timeout"));
	expect(
		await run("email.send", {
			to: "a@example.com",
			subject: "Hi",
			body: "Hello",
		}),
	).toMatchObject({ ok: false, reason: "may_not_have_gone_through" });
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("sends the exact approved MIME revision of a saved draft, retaining Bcc and inline files", async () => {
	const uid = "v1",
		draftId = "d",
		threadId = "thread";
	const bytes = Buffer.from(
		"To: a@example.com\r\nBcc: b@example.com\r\nSubject: Subject\r\n\r\nBody",
	).toString("base64url");
	fetch
		.mockResolvedValueOnce(
			Response.json({ drafts: [{ id: draftId, message: { id: uid } }] }),
		)
		.mockResolvedValueOnce(
			Response.json({
				id: draftId,
				message: {
					id: uid,
					threadId,
					labelIds: ["DRAFT"],
					internalDate: "1000",
					payload: {
						mimeType: "multipart/mixed",
						headers: [
							{ name: "To", value: "a@example.com" },
							{ name: "Bcc", value: "b@example.com" },
							{ name: "Subject", value: "Subject" },
						],
						parts: [
							{
								mimeType: "text/plain",
								body: { data: Buffer.from("Body").toString("base64url") },
							},
							{
								mimeType: "image/png",
								filename: "chart.png",
								body: { attachmentId: "part", size: 3 },
							},
						],
					},
				},
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				id: draftId,
				message: { id: uid, threadId, raw: bytes },
			}),
		)
		.mockResolvedValueOnce(Response.json({ id: "sent" }));
	const snapshot = {
		uid,
		etag: uid,
		draftId,
		threadId,
		to: "a@example.com",
		cc: "",
		bcc: "b@example.com",
		subject: "Subject",
		body: "Body",
		attachments: [{ name: "chart.png", size: 3 }],
		plainText: false,
	};
	expect(await run("email.send_draft", snapshot, uid)).toEqual({ ok: true });
	const posts = fetch.mock.calls.filter(([, o]) => o?.method === "POST");
	expect(posts).toHaveLength(1);
	expect(JSON.parse(String(posts[0][1]?.body))).toEqual({
		id: draftId,
		message: { raw: bytes, threadId },
	});
});
it("saves a new draft without addressing any send endpoint", async () => {
	fetch.mockResolvedValueOnce(Response.json({ id: "d" }));
	expect(
		(await run("email.draft", { subject: "Notes", body: "Draft only" })).ok,
	).toBe(true);
	expect(new URL(String(fetch.mock.calls[0][0])).pathname).toMatch(/\/drafts$/);
});
it("threaded replies bind Gmail threadId, References and In-Reply-To", async () => {
	fetch
		.mockResolvedValueOnce(
			Response.json({
				id: "m",
				threadId: "thread",
				labelIds: ["INBOX"],
				internalDate: "1000",
				payload: {
					headers: [
						{ name: "Subject", value: "Topic" },
						{ name: "Message-ID", value: "<origin@example.com>" },
					],
				},
			}),
		)
		.mockResolvedValueOnce(Response.json({ id: "sent" }));
	expect(
		(
			await run(
				"email.send",
				{ uid: "m", subject: "Re: Topic", to: "a@example.com", body: "Reply" },
				"m",
			)
		).ok,
	).toBe(true);
	const sent = JSON.parse(String(fetch.mock.calls[1][1]?.body));
	expect(sent.threadId).toBe("thread");
	expect(Buffer.from(sent.raw, "base64url").toString()).toContain(
		"In-Reply-To: <origin@example.com>",
	);
});
