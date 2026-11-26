import { z } from "zod";
import type { ConnectionPublic } from "../store";
import type { ImapAttachment, ImapFolder, ImapSearchCriteria } from "./imap";
import { microsoftGraphRequest } from "./microsoft-graph";
import { OneDriveError, onedriveGetAccessTokenForRead } from "./onedrive";

type Options = { fetch?: typeof fetch };
type Criteria = ImapSearchCriteria & { folder?: string; unseenOnly?: boolean };
const sender = z.object({
	emailAddress: z.object({ address: z.string(), name: z.string().nullish() }),
});
const headerSchema = z.object({
	id: z.string().min(1),
	subject: z.string().nullish(),
	from: sender.nullish(),
	receivedDateTime: z.string().nullish(),
	createdDateTime: z.string().optional(),
	isRead: z.boolean(),
	bodyPreview: z.string().nullish(),
});
const fields =
	"id,subject,from,receivedDateTime,createdDateTime,isRead,bodyPreview";
const headers = {
	Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
};
const special: Record<string, string> = {
	inbox: "inbox",
	sent: "sentitems",
	"sent items": "sentitems",
	trash: "deleteditems",
	"deleted items": "deleteditems",
	drafts: "drafts",
	archive: "archive",
	junk: "junkemail",
};
function segment(id: string) {
	if (!id || id === "." || id === "..")
		throw new OneDriveError("Invalid mail identifier", "invalid_path");
	return encodeURIComponent(id);
}
function folderPath(folder?: string) {
	const name = folder?.trim() || "inbox";
	return `/me/mailFolders/${segment(special[name.toLowerCase()] ?? name)}`;
}
function header(row: unknown) {
	const m = headerSchema.parse(row),
		address = m.from?.emailAddress;
	return {
		uid: m.id,
		subject: m.subject ?? "",
		from: address?.name
			? `${address.name} <${address.address}>`
			: (address?.address ?? ""),
		date: m.receivedDateTime ?? m.createdDateTime ?? "",
		seen: m.isRead,
		snippet: (m.bodyPreview ?? "").slice(0, 500),
	};
}
function assertResponse(r: Response) {
	if (!r.ok)
		throw new OneDriveError(
			"Outlook mail request failed",
			r.status === 404
				? "not_found"
				: r.status === 401 || r.status === 403
					? "needs_reauth"
					: "request_failed",
		);
}
async function readJson(token: string, path: string, opts?: Options) {
	const res = await microsoftGraphRequest(token, "GET", path, {
		...opts,
		headers,
	});
	assertResponse(res);
	return res.json();
}
async function* rows(
	token: string,
	path: string,
	params: URLSearchParams,
	opts?: Options,
) {
	let query = params.toString();
	const seen = new Set<string>();
	for (let page = 0; page < 30; page++) {
		if (seen.has(query))
			throw new OneDriveError(
				"Outlook returned a repeated page",
				"request_failed",
			);
		seen.add(query);
		const data = z
			.object({
				value: z.array(z.unknown()),
				"@odata.nextLink": z.string().optional(),
			})
			.parse(await readJson(token, `${path}?${query}`, opts));
		yield* data.value;
		if (!data["@odata.nextLink"]) return;
		const next = new URL(data["@odata.nextLink"]);
		const canonical = next.pathname.replace(
			/^\/v1\.0\/(?:me|users\/[^/]+)\//i,
			"/me/",
		);
		if (
			next.origin !== "https://graph.microsoft.com" ||
			next.username ||
			next.password ||
			next.hash ||
			!next.search ||
			!canonical.startsWith("/me/") ||
			canonical.toLowerCase().split("/").at(-1) !==
				path.toLowerCase().split("/").at(-1)
		)
			throw new OneDriveError(
				"Unexpected Outlook continuation",
				"request_failed",
			);
		query = next.search.slice(1);
	}
	throw new OneDriveError("Narrow the Outlook search", "too_large");
}
async function* matching(
	conn: ConnectionPublic,
	criteria: Criteria,
	opts?: Options,
) {
	for (const bound of [criteria.since, criteria.before])
		if (bound && !Number.isFinite(Date.parse(bound)))
			throw new OneDriveError("Invalid mail search date", "invalid_path");
	const token = await onedriveGetAccessTokenForRead(conn, opts, "email");
	const params = new URLSearchParams({ $select: fields, $top: "100" });
	if (criteria.query)
		params.set("$search", `"${criteria.query.replace(/["\\]/g, " ")}"`);
	else {
		params.set("$orderby", "receivedDateTime desc");
		const filter = [];
		for (const [date, op] of [
			[criteria.since, "ge"],
			[criteria.before, "lt"],
		] as const) {
			if (!date) continue;
			filter.push(`receivedDateTime ${op} ${new Date(date).toISOString()}`);
		}
		if (filter.length) params.set("$filter", filter.join(" and "));
	}
	let scanned = 0;
	for await (const row of rows(
		token,
		`${folderPath(criteria.folder)}/messages`,
		params,
		opts,
	)) {
		scanned++;
		const m = header(row);
		if (criteria.unseenOnly && m.seen) continue;
		if (
			criteria.from &&
			!m.from.toLowerCase().includes(criteria.from.toLowerCase())
		)
			continue;
		if (
			criteria.subject &&
			!m.subject.toLowerCase().includes(criteria.subject.toLowerCase())
		)
			continue;
		if (criteria.since && Date.parse(m.date) < Date.parse(criteria.since))
			continue;
		if (criteria.before && Date.parse(m.date) >= Date.parse(criteria.before))
			continue;
		yield m;
	}
	if (criteria.query && scanned >= 1000)
		throw new OneDriveError("Graph search result limit reached", "too_large");
}
export async function outlookMailList(
	conn: ConnectionPublic,
	criteria: Criteria,
	opts?: Options,
) {
	const messages = [];
	for await (const item of matching(conn, criteria, opts)) {
		messages.push(item);
		if (messages.length >= 25) break;
	}
	return messages;
}
export async function outlookMailCount(
	conn: ConnectionPublic,
	criteria: Criteria,
	opts?: Options,
) {
	if (
		!criteria.query &&
		!criteria.from &&
		!criteria.subject &&
		!criteria.since &&
		!criteria.before
	) {
		const token = await onedriveGetAccessTokenForRead(conn, opts, "email");
		const params = new URLSearchParams({
			$count: "true",
			$select: "id",
			$top: "1",
		});
		if (criteria.unseenOnly) params.set("$filter", "isRead eq false");
		const counts = z
			.object({ "@odata.count": z.number().int().nonnegative() })
			.parse(
				await readJson(
					token,
					`${folderPath(criteria.folder)}/messages?${params}`,
					opts,
				),
			);
		return counts["@odata.count"];
	}
	let count = 0;
	for await (const _ of matching(conn, criteria, opts)) count++;
	return count;
}
export async function outlookSendDraftSnapshot(
	conn: ConnectionPublic,
	uid: string,
	opts?: Options,
) {
	const token = await onedriveGetAccessTokenForRead(conn, opts, "email");
	const path = `/me/messages/${segment(uid)}`;
	const addresses = z
		.array(z.object({ emailAddress: z.object({ address: z.email() }) }))
		.transform((list) => list.map((r) => r.emailAddress.address).join(", "));
	const draft = z
		.object({
			id: z.literal(uid),
			isDraft: z.literal(true),
			"@odata.etag": z.string().min(1),
			subject: z.string(),
			toRecipients: addresses,
			ccRecipients: addresses,
			bccRecipients: addresses,
			body: z.object({
				contentType: z.string().refine((v) => v.toLowerCase() === "text"),
				content: z.string().max(250000),
			}),
		})
		.parse(
			await readJson(
				token,
				path +
					"?$select=id,isDraft,subject,toRecipients,ccRecipients,bccRecipients,body",
				opts,
			),
		);
	if (!draft.toRecipients && !draft.ccRecipients && !draft.bccRecipients)
		throw new OneDriveError("The draft has no recipients", "invalid_path");
	const attachments = [];
	for await (const row of rows(
		token,
		`${path}/attachments`,
		new URLSearchParams({ $select: "id,name,size" }),
		opts,
	)) {
		attachments.push(
			z
				.object({
					id: z.string().min(1),
					name: z.string().min(1),
					size: z.number().int().nonnegative(),
				})
				.parse(row),
		);
	}
	attachments.sort((a, b) => a.id.localeCompare(b.id));
	return {
		uid,
		etag: draft["@odata.etag"],
		to: draft.toRecipients,
		cc: draft.ccRecipients,
		bcc: draft.bccRecipients,
		subject: draft.subject,
		body: draft.body.content,
		attachments,
	};
}
// A proposed change needs a name, identity and revision for its card. Its body and attachments stay in Outlook.
export async function outlookMailMetadata(
	conn: ConnectionPublic,
	uid: string,
	folder?: string,
	opts?: Options,
) {
	const token = await onedriveGetAccessTokenForRead(conn, opts, "email");
	const path = `${folder ? folderPath(folder) : "/me"}/messages/${segment(uid)}`;
	const row = await readJson(
		token,
		`${path}?$select=id,from,subject,receivedDateTime,createdDateTime,isRead,isDraft`,
		opts,
	);
	const metadata = z
		.object({ isDraft: z.boolean(), "@odata.etag": z.string().optional() })
		.parse(row);
	return {
		header: header(row),
		etag: metadata["@odata.etag"],
		isDraft: metadata.isDraft,
	};
}
export async function outlookReadMail(
	conn: ConnectionPublic,
	uid: string,
	folder?: string,
	opts?: Options,
) {
	const token = await onedriveGetAccessTokenForRead(conn, opts, "email");
	const path = `${folder ? folderPath(folder) : "/me"}/messages/${segment(uid)}`;
	const row = await readJson(
		token,
		`${path}?$select=${fields},body,hasAttachments,isDraft`,
		opts,
	);
	const body = z
		.object({
			body: z.object({ contentType: z.literal("text"), content: z.string() }),
			hasAttachments: z.boolean(),
			isDraft: z.boolean().optional(),
		})
		.parse(row);
	const attachments: ImapAttachment[] = [];
	if (body.hasAttachments)
		for await (const item of rows(
			token,
			`${path}/attachments`,
			new URLSearchParams({ $select: "name,contentType,size" }),
			opts,
		)) {
			const att = z
				.object({
					name: z.string(),
					contentType: z.string().nullish(),
					size: z.number().int().nonnegative(),
				})
				.parse(item);
			attachments.push({
				filename: att.name,
				contentType: att.contentType ?? "application/octet-stream",
				size: att.size,
			});
		}
	return {
		header: header(row),
		etag:
			typeof row["@odata.etag"] === "string" ? row["@odata.etag"] : undefined,
		text: body.body.content.slice(0, 20000),
		attachments,
		isDraft: body.isDraft === true,
	};
}
export async function outlookMailFolders(
	conn: ConnectionPublic,
	opts?: Options,
) {
	const token = await onedriveGetAccessTokenForRead(conn, opts, "email");
	const folders: ImapFolder[] = [];
	const queue = ["/me/mailFolders"];
	const visited = new Set<string>();
	for (const path of queue) {
		for await (const item of rows(
			token,
			path,
			new URLSearchParams({ $select: "id,displayName,childFolderCount" }),
			opts,
		)) {
			const f = z
				.object({
					id: z.string(),
					displayName: z.string(),
					childFolderCount: z.number().int().nonnegative(),
				})
				.parse(item);
			if (visited.has(f.id) || visited.size >= 1000)
				throw new OneDriveError("Outlook folder limit reached", "too_large");
			visited.add(f.id);
			folders.push({ path: f.id, name: f.displayName });
			if (f.childFolderCount) queue.push(`${folderPath(f.id)}/childFolders`);
		}
	}
	return folders;
}
