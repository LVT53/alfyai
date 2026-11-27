import { z } from "zod";
import type { ConnectionPublic } from "../store";
import { gmailGetAccessToken } from "./gmail";
import {
	type ImapAttachment,
	ImapError,
	type ImapSearchCriteria,
	stripMailHtml,
} from "./imap";

type Options = { fetch?: typeof fetch; readToken?: string };
async function readSession(
	conn: ConnectionPublic,
	opts?: Options,
): Promise<Options> {
	return {
		...opts,
		readToken:
			opts?.readToken ?? (await gmailGetAccessToken(conn, opts, "read")),
	};
}
type Criteria = ImapSearchCriteria & {
	folder?: string;
	unseenOnly?: boolean;
	limit?: number;
};
const id = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/);
const label = z.object({
	id,
	name: z.string(),
	type: z.enum(["system", "user"]),
});
const partBase = z.object({
	mimeType: z.string().optional(),
	filename: z.string().optional(),
	headers: z
		.array(z.object({ name: z.string(), value: z.string() }))
		.optional(),
	body: z
		.object({
			size: z.number().optional(),
			data: z.string().optional(),
			attachmentId: id.optional(),
		})
		.optional(),
});
type Part = z.infer<typeof partBase> & { parts?: Part[] };
const part: z.ZodType<Part> = partBase.extend({
	parts: z.lazy(() => z.array(part)).optional(),
});
const msg = z.object({
	id,
	threadId: id,
	labelIds: z.array(z.string()).default([]),
	snippet: z.string().optional(),
	internalDate: z.string().regex(/^\d+$/),
	payload: part,
});
type Message = z.infer<typeof msg>;
const list = z.object({
	messages: z.array(z.object({ id })).optional(),
	nextPageToken: z.string().min(1).optional(),
});
const draftList = z.object({
	drafts: z.array(z.object({ id, message: z.object({ id }) })).optional(),
	nextPageToken: z.string().min(1).optional(),
});
const draft = z.object({ id, message: msg });
const aliases: Record<string, string> = {
	inbox: "INBOX",
	sent: "SENT",
	drafts: "DRAFT",
	draft: "DRAFT",
	spam: "SPAM",
	trash: "TRASH",
	starred: "STARRED",
};
function bad(message: string) {
	return new ImapError(message, "request_failed");
}
export function gmailId(value: unknown) {
	return id.parse(value);
}
export async function gmailRequest(
	conn: ConnectionPublic,
	path: string,
	params: URLSearchParams,
	opts?: Options,
	mutation?: { method: "POST" | "PUT"; body: unknown },
) {
	const token =
		(!mutation && opts?.readToken) ||
		(await gmailGetAccessToken(conn, opts, mutation ? "modify" : "read"));
	const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
	if (
		!url.pathname.startsWith("/gmail/v1/users/me/") ||
		url.search ||
		url.hash ||
		!/^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path)
	)
		throw bad("Invalid Gmail resource");
	url.search = params.toString();
	const response = await (opts?.fetch ?? fetch)(url.toString(), {
		method: mutation?.method ?? "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			...(mutation ? { "Content-Type": "application/json" } : {}),
		},
		redirect: "error",
		signal: AbortSignal.timeout(20000),
		...(mutation ? { body: JSON.stringify(mutation.body) } : {}),
	});
	if (!response.ok)
		throw new ImapError(
			"Gmail request failed",
			response.status === 404
				? "message_not_found"
				: response.status === 401 || response.status === 403
					? "needs_reauth"
					: "request_failed",
		);
	const reader = response.body?.getReader();
	if (!reader) throw bad("Missing Gmail response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > 12_000_000) {
				await reader.cancel();
				throw bad("Gmail result too large");
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
const h = (part: Part, name: string) =>
	part.headers
		?.filter((x) => x.name.toLowerCase() === name.toLowerCase())
		.map((x) => x.value)
		.join(", ") ?? "";
function header(m: Message) {
	return {
		uid: m.id,
		threadId: m.threadId,
		from: h(m.payload, "From"),
		subject: h(m.payload, "Subject"),
		date: new Date(Number(m.internalDate)).toISOString(),
		seen: !m.labelIds.includes("UNREAD"),
		snippet: (m.snippet ?? "").slice(0, 500),
	};
}
async function content(conn: ConnectionPublic, m: Message, opts?: Options) {
	const plain: string[] = [],
		html: string[] = [],
		attachments: ImapAttachment[] = [];
	const walk = async (p: Part): Promise<void> => {
		const disposition = h(p, "Content-Disposition");
		if (
			p.filename ||
			(p.body?.attachmentId &&
				p.mimeType !== "text/plain" &&
				p.mimeType !== "text/html") ||
			/^attachment\b/i.test(disposition)
		) {
			attachments.push({
				filename: p.filename || "Attachment",
				contentType: p.mimeType ?? "application/octet-stream",
				size: p.body?.size,
			});
			return;
		}
		if (
			p.body?.attachmentId &&
			(p.mimeType === "text/plain" || p.mimeType === "text/html")
		) {
			if ((p.body.size ?? Infinity) > 750000)
				throw bad("The Gmail message body is too large to read completely");
			const bytes = z
				.object({
					data: z.string(),
					size: z.number().int().nonnegative().max(750000),
				})
				.parse(
					await gmailRequest(
						conn,
						`messages/${m.id}/attachments/${p.body.attachmentId}`,
						new URLSearchParams(),
						opts,
					),
				);
			if (bytes.size !== p.body.size) throw bad("Gmail body size changed");
			p.body = { data: bytes.data, size: bytes.size };
		}

		if (
			p.body?.data &&
			(p.mimeType === "text/plain" || p.mimeType === "text/html")
		) {
			const charset =
				/charset\s*=\s*["']?([^;"'\s]+)/i.exec(h(p, "Content-Type"))?.[1] ??
				"utf-8";
			let decoded: string;
			try {
				decoded = new TextDecoder(charset).decode(
					Buffer.from(p.body.data, "base64url"),
				);
			} catch {
				throw bad("Unsupported message character set");
			}
			if (p.mimeType === "text/plain") plain.push(decoded);
			else html.push(stripMailHtml(decoded));
		}
		for (const child of p.parts ?? []) await walk(child);
	};
	await walk(m.payload);
	return {
		header: header(m),
		text: (plain.length ? plain : html).join("\n"),
		attachments,
		isDraft: m.labelIds.includes("DRAFT"),
		etag: m.id,
	};
}
export async function gmailMailFolders(conn: ConnectionPublic, opts?: Options) {
	const result = z
		.object({ labels: z.array(label) })
		.parse(await gmailRequest(conn, "labels", new URLSearchParams(), opts));
	return result.labels.map((l) => ({ name: l.name, path: l.id, type: l.type }));
}
async function folderId(
	conn: ConnectionPublic,
	folder: string | undefined,
	opts?: Options,
) {
	if (!folder) return "INBOX";
	if (Object.hasOwn(aliases, folder.toLowerCase()))
		return aliases[folder.toLowerCase()];
	const labels = await gmailMailFolders(conn, opts);
	const selected =
		labels.find((l) => l.path === folder) ||
		labels.find((l) => l.name === folder);
	if (!selected) throw new ImapError("Unknown Gmail label", "folder_not_found");
	return selected.path;
}
async function queryParams(
	conn: ConnectionPublic,
	c: Criteria,
	opts?: Options,
) {
	const terms = [c.query ?? "", c.unseenOnly ? "is:unread" : ""];
	for (const [key, v] of [
		["from", c.from],
		["subject", c.subject],
	] as const)
		if (v) terms.push(`${key}:"${v.replace(/["\\\r\n]/g, " ")}"`);
	for (const [key, v] of [
		["after", c.since],
		["before", c.before],
	] as const)
		if (v) {
			const date = Date.parse(v);
			if (!Number.isFinite(date)) throw bad("Invalid search date");
			terms.push(`${key}:${Math.floor(date / 1000)}`);
		}
	const folder = await folderId(conn, c.folder, opts);
	return new URLSearchParams({
		q: terms.filter(Boolean).join(" "),
		labelIds: folder,
		...(folder === "SPAM" || folder === "TRASH"
			? { includeSpamTrash: "true" }
			: {}),
	});
}
async function message(
	conn: ConnectionPublic,
	uid: string,
	format: "full" | "metadata",
	opts?: Options,
) {
	const params = new URLSearchParams({ format });
	if (format === "metadata")
		for (const k of [
			"From",
			"Subject",
			"Message-ID",
			"References",
			"To",
			"Cc",
			"Bcc",
		])
			params.append("metadataHeaders", k);
	const result = msg.parse(
		await gmailRequest(conn, `messages/${gmailId(uid)}`, params, opts),
	);
	if (result.id !== uid) throw bad("Unexpected Gmail message");
	return result;
}
export async function gmailMailList(
	conn: ConnectionPublic,
	c: Criteria,
	opts?: Options,
) {
	opts = await readSession(conn, opts);
	const params = await queryParams(conn, c, opts);
	params.set("maxResults", String(Math.max(1, Math.min(c.limit ?? 25, 25))));
	const page = list.parse(await gmailRequest(conn, "messages", params, opts));
	const ids = page.messages ?? [];
	const out = [];
	for (let i = 0; i < ids.length; i += 5)
		out.push(
			...(await Promise.all(
				ids
					.slice(i, i + 5)
					.map(async (item) =>
						header(await message(conn, item.id, "metadata", opts)),
					),
			)),
		);
	return out;
}
export async function gmailMailCount(
	conn: ConnectionPublic,
	c: Criteria,
	opts?: Options,
) {
	opts = await readSession(conn, opts);
	if (!c.query && !c.from && !c.subject && !c.since && !c.before) {
		const labelId = await folderId(conn, c.folder, opts);
		const data = z
			.object({
				id: z.literal(labelId),
				messagesTotal: z.number().int().nonnegative(),
				messagesUnread: z.number().int().nonnegative(),
			})
			.parse(
				await gmailRequest(
					conn,
					`labels/${gmailId(labelId)}`,
					new URLSearchParams({ fields: "id,messagesTotal,messagesUnread" }),
					opts,
				),
			);
		return c.unseenOnly ? data.messagesUnread : data.messagesTotal;
	}
	const params = await queryParams(conn, c, opts);
	params.set("maxResults", "500");
	params.set("fields", "messages/id,nextPageToken");
	const seen = new Set<string>(),
		ids = new Set<string>();
	for (let page = 0; page < 30; page++) {
		const data = list.parse(await gmailRequest(conn, "messages", params, opts));
		for (const m of data.messages ?? []) ids.add(m.id);
		if (!data.nextPageToken) return ids.size;
		if (seen.has(data.nextPageToken)) break;
		seen.add(data.nextPageToken);
		params.set("pageToken", data.nextPageToken);
	}
	throw bad("Narrow the Gmail count");
}
export async function gmailReadMail(
	conn: ConnectionPublic,
	uid: string,
	folder?: string,
	opts?: Options,
) {
	const m = await message(conn, uid, "full", opts);
	if (folder && !m.labelIds.includes(await folderId(conn, folder, opts)))
		throw new ImapError("Message outside requested label", "message_not_found");
	const r = await content(conn, m, opts);
	return { ...r, text: r.text.slice(0, 10000) };
}
export async function gmailMailMetadata(
	conn: ConnectionPublic,
	uid: string,
	folder?: string,
	opts?: Options,
) {
	const m = await message(conn, uid, "metadata", opts);
	if (folder && !m.labelIds.includes(await folderId(conn, folder, opts)))
		throw new ImapError("Message outside requested label", "message_not_found");
	return {
		header: header(m),
		isDraft: m.labelIds.includes("DRAFT"),
		etag: m.id,
		messageId: h(m.payload, "Message-ID"),
		references: h(m.payload, "References"),
	};
}
export async function gmailReadThread(
	conn: ConnectionPublic,
	threadId: string,
	opts?: Options,
) {
	const t = z
		.object({ id, messages: z.array(msg).min(1).max(150) })
		.parse(
			await gmailRequest(
				conn,
				`threads/${gmailId(threadId)}`,
				new URLSearchParams({ format: "full" }),
				opts,
			),
		);
	if (t.id !== threadId || t.messages.some((m) => m.threadId !== threadId))
		throw bad("Unexpected Gmail thread");
	const messages = [];
	for (const m of t.messages) messages.push(await content(conn, m, opts));
	const text = messages.map((m) => m.text).join("\n\n");
	return {
		messages: messages.map((m) => m.header),
		text: text.slice(0, 30000),
		truncated: text.length > 30000,
	};
}
export async function gmailDraftSnapshot(
	conn: ConnectionPublic,
	uid: string,
	opts?: Options,
) {
	gmailId(uid);
	opts = await readSession(conn, opts);
	const params = new URLSearchParams({
		maxResults: "500",
		fields: "drafts(id,message/id),nextPageToken",
	});
	const seen = new Set<string>();
	for (let i = 0; i < 30; i++) {
		const page = draftList.parse(
			await gmailRequest(conn, "drafts", params, opts),
		);
		const found = page.drafts?.find((d) => d.message.id === uid);
		if (found) {
			const d = draft.parse(
				await gmailRequest(
					conn,
					`drafts/${found.id}`,
					new URLSearchParams({ format: "full" }),
					opts,
				),
			);
			if (
				d.id !== found.id ||
				d.message.id !== uid ||
				!d.message.labelIds.includes("DRAFT")
			)
				throw bad("Draft changed");
			const m = d.message;
			// Resent envelopes can deliver to a different set of recipients
			// from the To/Cc/Bcc fields on the confirmation card.
			if (m.payload.headers?.some((header) => /^resent-/i.test(header.name)))
				throw bad("Unsupported draft delivery headers");
			const r = await content(conn, m, opts);
			if (r.text.length > 250000) throw bad("Draft too large for review");
			return {
				uid,
				etag: m.id,
				draftId: d.id,
				threadId: m.threadId,
				to: h(m.payload, "To"),
				cc: h(m.payload, "Cc"),
				bcc: h(m.payload, "Bcc"),
				subject: r.header.subject,
				body: r.text,
				attachments: r.attachments.map((a) => ({
					name: a.filename,
					size: a.size ?? 0,
				})),
				plainText: m.payload.mimeType === "text/plain" && !r.attachments.length,
			};
		}
		if (!page.nextPageToken || seen.has(page.nextPageToken)) break;
		seen.add(page.nextPageToken);
		params.set("pageToken", page.nextPageToken);
	}
	throw new ImapError("Gmail draft revision unavailable", "message_not_found");
}
