import { decodeHTML } from "entities";
import { z } from "zod";
import { microsoftCanWrite } from "$lib/shared/microsoft-permissions";
import { bearerAuthHeader, providerFetch } from "../provider-http";
import { type ConnectionPublic, getConnection } from "../store";
import type { WriteExecutor } from "../write-executors";
import { onedriveGetAccessTokenForRead } from "./onedrive";

const id = z
	.string()
	.regex(/^[\w:!@.~-]{1,1024}$/)
	.refine((s) => s !== "." && s !== "..");
export const teamsToolInputSchema = z.object({
	action: z.enum([
		"list_chats",
		"list_teams",
		"list_channels",
		"list_messages",
		"list_replies",
		"read_message",
		"send",
		"reply",
		"set_reaction",
		"remove_reaction",
	]),
	account: z.string().trim().max(320).optional(),
	chatId: id.optional(),
	teamId: id.optional(),
	channelId: id.optional(),
	messageId: id.optional(),
	replyId: id.optional(),
	body: z.string().min(1).max(8000).optional(),
	reaction: z
		.string()
		.max(32)
		.regex(
			/^\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic})*$/u,
		)
		.optional(),
	limit: z.number().int().min(1).max(50).optional(),
});
export type TeamsInput = z.infer<typeof teamsToolInputSchema>;
type FetchOptions = { fetch?: typeof fetch };
type TeamsCapability = "teams_chat" | "teams_channels" | "teams_files";
const root = "https://graph.microsoft.com/v1.0";
function part(s: string | undefined) {
	return encodeURIComponent(id.parse(s));
}
export function teamsRoute(i: TeamsInput) {
	const { action, chatId, teamId, channelId, messageId, replyId } = i;
	const reaction = action === "set_reaction" || action === "remove_reaction";
	const write = reaction || action === "send" || action === "reply";
	const directory = action === "list_teams" || action === "list_channels";
	if (
		Boolean(i.body) !== (action === "send" || action === "reply") ||
		Boolean(i.reaction) !== reaction ||
		(write && i.limit !== undefined)
	)
		throw Error("Invalid Teams content");
	if (
		Boolean(messageId) !==
			(action === "list_replies" ||
				action === "read_message" ||
				action === "reply" ||
				reaction) ||
		(replyId && !(action === "read_message" || reaction))
	)
		throw Error("Invalid Teams message target");
	if (directory || action === "list_chats") {
		if (chatId || channelId || Boolean(teamId) !== (action === "list_channels"))
			throw Error("Invalid Teams directory target");
		return {
			path:
				action === "list_chats"
					? "/me/chats"
					: action === "list_teams"
						? "/me/joinedTeams"
						: `/teams/${part(teamId)}/channels`,
			write,
			directory,
			chat: action === "list_chats",
		};
	}
	if (
		chatId
			? teamId ||
				channelId ||
				replyId ||
				action === "reply" ||
				action === "list_replies"
			: !teamId || !channelId
	)
		throw Error("Invalid Teams destination");
	const destination = chatId
		? `/chats/${part(chatId)}`
		: `/teams/${part(teamId)}/channels/${part(channelId)}`;
	const messages = `${destination}/messages`;
	const parent = messageId ? `${messages}/${part(messageId)}` : messages;
	const target = replyId ? `${parent}/replies/${part(replyId)}` : parent;
	const path = reaction
		? target + (action === "set_reaction" ? "/setReaction" : "/unsetReaction")
		: action === "reply" || action === "list_replies"
			? `${parent}/replies`
			: target;
	return { path, write, directory, chat: Boolean(chatId), destination, target };
}
export class TeamsReadError extends Error {
	constructor(readonly status: number) {
		super("Teams request failed");
	}
}
const identity = z.object({ displayName: z.string().nullish() });
const entry = z.object({
	id: id,
	topic: z.string().nullish(),
	displayName: z.string().nullish(),
	members: z.array(identity).nullish(),
	webUrl: z.string().nullish(),
	body: z.object({ contentType: z.string(), content: z.string() }).nullish(),
	from: z
		.object({ user: identity.nullish(), application: identity.nullish() })
		.nullish(),
	createdDateTime: z.string().nullish(),
	deletedDateTime: z.string().nullish(),
	reactions: z.array(z.object({ reactionType: z.string() })).nullish(),
});
function link(s: string | null | undefined) {
	if (!s) return "";
	try {
		const u = new URL(s);
		const valid =
			u.protocol === "https:" &&
			!u.username &&
			!u.password &&
			!u.port &&
			["teams.microsoft.com", "teams.cloud.microsoft"].includes(u.hostname) &&
			/^\/l\/(message|channel|chat|team)\/[^/]+/.test(u.pathname);
		if (!valid) return "";
		u.hash = "";
		for (const key of [...u.searchParams.keys()]) {
			if (
				!["tenantId", "groupId", "parentMessageId", "createdTime"].includes(key)
			)
				u.searchParams.delete(key);
		}
		return u.href;
	} catch {
		return "";
	}
}
function item(raw: unknown) {
	const r = entry.parse(raw);
	const content = r.body?.content ?? "";
	const plain =
		r.body?.contentType.toLowerCase() === "html"
			? decodeHTML(
					content
						.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
						.replace(/<br\s*\/?>|<\/p>/gi, "\n")
						.replace(/<[^>]*>/g, ""),
				)
			: content;
	return {
		id: r.id,
		label: (
			r.topic ||
			r.displayName ||
			r.members
				?.map((m) => m.displayName)
				.filter(Boolean)
				.join(", ") ||
			r.from?.user?.displayName ||
			r.from?.application?.displayName ||
			r.id
		).slice(0, 320),
		body: r.deletedDateTime ? "" : plain.slice(0, 8000),
		url: link(r.webUrl),
		deleted: Boolean(r.deletedDateTime),
		time: r.createdDateTime ?? null,
		reactions: r.reactions?.map((x) => x.reactionType).slice(0, 50) ?? [],
	};
}
async function get(token: string, url: URL, opts: FetchOptions) {
	const res = await providerFetch(url.href, {
		...opts,
		redirect: "error",
		headers: bearerAuthHeader(token),
	});
	if (!res.ok) throw new TeamsReadError(res.status);
	return res.json();
}
export async function teamsRead(
	conn: ConnectionPublic,
	i: TeamsInput,
	cap: TeamsCapability,
	opts: FetchOptions = {},
) {
	const r = teamsRoute(i);
	if (
		r.write ||
		(cap === "teams_files"
			? !r.directory
			: cap !== (r.chat ? "teams_chat" : "teams_channels"))
	)
		throw Error("Unsupported Teams read");
	const token = await onedriveGetAccessTokenForRead(conn, opts, cap);
	const url = new URL(root + r.path);
	if (i.action === "list_chats") url.searchParams.set("$expand", "members");
	if (i.action === "read_message") {
		const row = item(await get(token, url, opts));
		if (row.id !== (i.replyId ?? i.messageId) || row.deleted)
			throw new TeamsReadError(404);
		return { items: [row], more: false };
	}
	const limit = i.limit ?? 20,
		items: ReturnType<typeof item>[] = [];
	let next: URL | null = url;
	for (let page = 0; next && page < 5; page++) {
		const data = z
			.object({
				value: z.array(z.unknown()),
				"@odata.nextLink": z.string().nullish(),
			})
			.parse(await get(token, next, opts));
		for (const raw of data.value) {
			const row = item(raw);
			if (!row.deleted) items.push(row);
		}
		const href = data["@odata.nextLink"];
		if (items.length >= limit)
			return {
				items: items.slice(0, limit),
				more: Boolean(href) || items.length > limit,
			};
		next = href ? new URL(href) : null;
		if (
			next &&
			(next.origin !== url.origin ||
				next.username ||
				next.password ||
				next.hash ||
				decodeURIComponent(next.pathname) !==
					decodeURIComponent(url.pathname) ||
				[...next.searchParams].some(([key, value]) => {
					if (key === "$skiptoken" || key === "$skipToken")
						return value.length > 8192;
					if (key === "$top" || key === "$skip")
						return !/^\d{1,7}$/.test(value);
					return (
						!url.searchParams.has(key) || url.searchParams.get(key) !== value
					);
				}))
		)
			throw Error("Invalid Teams continuation");
	}
	return { items, more: Boolean(next) };
}
export async function teamsDestination(
	conn: ConnectionPublic,
	i: TeamsInput,
	opts: FetchOptions = {},
) {
	const r = teamsRoute(i);
	if (!r.write || !r.destination) throw Error("Invalid proposal");
	const token = await onedriveGetAccessTokenForRead(
		conn,
		opts,
		r.chat ? "teams_chat" : "teams_channels",
	);
	const dest = new URL(root + r.destination);
	if (r.chat) dest.searchParams.set("$expand", "members");
	const [destination, original, team] = await Promise.all([
		get(token, dest, opts).then(item),
		i.messageId ? get(token, new URL(root + r.target), opts).then(item) : null,
		i.teamId
			? get(token, new URL(`${root}/teams/${part(i.teamId)}`), opts).then(item)
			: null,
	]);
	if (
		destination.id !== (i.chatId ?? i.channelId) ||
		(team && team.id !== i.teamId) ||
		(original &&
			(original.id !== (i.replyId ?? i.messageId) || original.deleted))
	)
		throw new TeamsReadError(404);
	return {
		destination: team
			? [team.label, destination.label].join(" / ")
			: destination.label,
		original: original
			? [original.label, original.body.slice(0, 180)]
					.filter(Boolean)
					.join(" · ")
			: null,
	};
}
export const executeTeamsWrite: WriteExecutor["execute"] = async (
	userId,
	connectionId,
	op,
	content,
	opts,
) => {
	let submitted = false;
	try {
		const conn = await getConnection(userId, connectionId);
		const i = teamsToolInputSchema.parse(JSON.parse(content));
		const r = teamsRoute(i);
		if (
			!r.write ||
			op.action !== `teams.${i.action}` ||
			op.target?.id !== r.path ||
			op.connectionId !== connectionId ||
			op.provider !== "onedrive"
		)
			return { ok: false, reason: "invalid_target" };
		const capability = r.chat ? "teams_chat" : "teams_channels";
		if (
			conn?.provider !== "onedrive" ||
			conn.status !== "connected" ||
			!microsoftCanWrite(conn, capability)
		)
			return { ok: false, reason: "writes_not_allowed" };
		const token = await onedriveGetAccessTokenForRead(conn, opts, capability);
		submitted = true;
		const res = await providerFetch(root + r.path, {
			...opts,
			method: "POST",
			redirect: "error",
			headers: {
				...bearerAuthHeader(token),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(
				i.reaction
					? { reactionType: i.reaction }
					: { body: { contentType: "text", content: i.body } },
			),
		});
		if (res.status === (i.reaction ? 204 : 201)) return { ok: true };
		return {
			ok: false,
			reason:
				res.status === 401 || res.status === 403
					? "needs_reauth"
					: res.status >= 500
						? "may_not_have_gone_through"
						: "provider_error",
		};
	} catch {
		return {
			ok: false,
			reason: submitted ? "may_not_have_gone_through" : "provider_error",
		};
	}
};
