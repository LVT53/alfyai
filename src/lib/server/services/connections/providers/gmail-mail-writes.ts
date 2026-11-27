import addressparser from "nodemailer/lib/addressparser/index.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { z } from "zod";
import { getConnection } from "../store";
import type { WriteExecutor } from "../write-executors";
import { idempotencyKey } from "../write-guard";
import { gmailCanModify } from "./gmail";
import {
	gmailDraftSnapshot,
	gmailId,
	gmailMailFolders,
	gmailMailMetadata,
	gmailRequest,
} from "./gmail-mail";

const safeHeader = z
	.string()
	.max(998)
	.refine((x) => !/[\r\n]/.test(x) && !x.includes(String.fromCharCode(0)));
const composition = z.object({
	to: safeHeader.optional(),
	cc: safeHeader.optional(),
	subject: safeHeader.optional(),
	body: z.string().max(250000).optional(),
});
function addresses(input: string | undefined) {
	if (input === undefined) return undefined;
	return addressparser(input, { flatten: true }).map(({ address, name }) => ({
		address: z.email().parse(address),
		name: safeHeader.parse(name),
	}));
}
async function mime(
	input: z.infer<typeof composition>,
	sender: string,
	identity: string,
	reply?: { messageId: string; references: string },
) {
	const built = new MailComposer({
		from: z.email().parse(sender),
		to: addresses(input.to),
		cc: addresses(input.cc),
		subject: input.subject ?? "",
		text: input.body ?? "",
		messageId: `<${identity}@alfyai.invalid>`,
		...(reply
			? {
					inReplyTo: safeHeader.parse(reply.messageId),
					references: safeHeader.parse(
						[reply.references, reply.messageId].filter(Boolean).join(" "),
					),
				}
			: {}),
		disableFileAccess: true,
		disableUrlAccess: true,
	}).compile();
	return (await built.build()).toString("base64url");
}
function replaceDraftFields(
	raw: string,
	change: z.infer<typeof composition>,
	newRaw: string,
) {
	const original = Buffer.from(raw, "base64url").toString("latin1"),
		fresh = Buffer.from(newRaw, "base64url").toString("latin1");
	const separator = /\r?\n\r?\n/;
	const split = (s: string) => {
		const pos = separator.exec(s);
		if (!pos) throw Error("Invalid MIME draft");
		return {
			headers: s.slice(0, pos.index).split(/\r?\n(?![ \t])/),
			body: s.slice(pos.index + pos[0].length),
		};
	};
	const a = split(original),
		b = split(fresh),
		keys = new Set<string>();
	for (const k of ["to", "cc", "subject"] as const)
		if (change[k] !== undefined) keys.add(k);
	if (change.body !== undefined)
		for (const key of [
			"content-type",
			"content-transfer-encoding",
			"mime-version",
		])
			keys.add(key);
	const name = (line: string) => line.slice(0, line.indexOf(":")).toLowerCase();
	return Buffer.from(
		[
			...a.headers.filter((l) => !keys.has(name(l))),
			...b.headers.filter((l) => keys.has(name(l))),
		].join("\r\n") +
			"\r\n\r\n" +
			(change.body === undefined ? a.body : b.body),
		"latin1",
	).toString("base64url");
}
export const executeGmailMailWrite: WriteExecutor["execute"] = async (
	userId,
	connectionId,
	op,
	content,
	opts,
) => {
	const conn = await getConnection(userId, connectionId);
	if (
		conn?.provider !== "google" ||
		conn.status !== "connected" ||
		!conn.allowWrites ||
		!conn.capabilities.includes("email") ||
		!gmailCanModify(conn)
	)
		return { ok: false, reason: "writes_not_allowed" };
	let submitted = false;
	try {
		const p = z.record(z.string(), z.unknown()).parse(JSON.parse(content));
		const uid = p.uid === undefined ? undefined : gmailId(p.uid);
		if (uid !== undefined && uid !== op.target?.id)
			return { ok: false, reason: "invalid_target" };
		const write = (
			path: string,
			body: unknown,
			method: "POST" | "PUT" = "POST",
		) =>
			gmailRequest(conn, path, new URLSearchParams(), opts, { method, body });
		if (op.action === "email.send_draft" || op.action === "email.edit_draft") {
			if (!uid || p.etag !== uid)
				return { ok: false, reason: "invalid_target" };
			const current = await gmailDraftSnapshot(conn, uid, opts);
			if (
				op.action === "email.send_draft" &&
				JSON.stringify(current) !== JSON.stringify(p)
			)
				return { ok: false, reason: "target_changed" };
			const d = z
				.object({
					id: z.literal(current.draftId),
					message: z.object({
						id: z.literal(uid),
						threadId: z.literal(current.threadId),
						raw: z.string().min(1),
					}),
				})
				.parse(
					await gmailRequest(
						conn,
						`drafts/${current.draftId}`,
						new URLSearchParams({ format: "raw" }),
						opts,
					),
				);
			let raw = d.message.raw;
			if (op.action === "email.edit_draft") {
				const changes = composition.parse(p);
				if (
					!Object.values(changes).some((v) => v !== undefined) ||
					(changes.body !== undefined && !current.plainText)
				)
					return { ok: false, reason: "unsupported_operation" };
				raw = replaceDraftFields(
					raw,
					changes,
					await mime(changes, conn.accountIdentifier ?? "", idempotencyKey(op)),
				);
			} else {
				if (!current.to && !current.cc && !current.bcc)
					return { ok: false, reason: "invalid_target" };
				submitted = true;
			}
			const body = { id: d.id, message: { raw, threadId: current.threadId } };
			if (submitted) await write("drafts/send", body);
			else await write(`drafts/${d.id}`, body, "PUT");
		} else if (op.action === "email.send" || op.action === "email.draft") {
			const fields = composition.parse(p);
			if (
				op.action === "email.send" &&
				(!addresses(fields.to)?.length || !fields.body || !fields.subject)
			)
				return { ok: false, reason: "invalid_target" };
			let reply: Awaited<ReturnType<typeof gmailMailMetadata>> | undefined;
			if (uid) {
				reply = await gmailMailMetadata(conn, uid, undefined, opts);
				if (
					reply.isDraft ||
					!/^<[^\s<>]+@[^\s<>]+>$/.test(reply.messageId) ||
					fields.subject?.replace(/^re:\s*/i, "") !==
						reply.header.subject.replace(/^re:\s*/i, "")
				)
					return { ok: false, reason: "invalid_target" };
			}
			const raw = await mime(
				fields,
				conn.accountIdentifier ?? "",
				idempotencyKey(op),
				reply,
			);
			const m = { raw, ...(reply ? { threadId: reply.header.threadId } : {}) };
			submitted = op.action === "email.send";
			await write(
				submitted ? "messages/send" : "drafts",
				submitted ? m : { message: m },
			);
		} else if (uid) {
			if (op.action === "email.trash") await write(`messages/${uid}/trash`, {});
			else if (op.action === "email.flag" || op.action === "email.label") {
				let labelId: string;
				let add = z.boolean().parse(p.value);
				if (op.action === "email.flag") {
					const flag = z.enum(["seen", "flagged"]).parse(p.flag);
					labelId = flag === "seen" ? "UNREAD" : "STARRED";
					if (flag === "seen") add = !add;
				} else {
					labelId = gmailId(p.labelId);
					const labels = await gmailMailFolders(conn, opts);
					if (
						!labels.some(
							(l) =>
								l.path === labelId &&
								l.type === "user" &&
								l.name === p.labelName,
						)
					)
						return { ok: false, reason: "target_changed" };
				}
				await write(
					`messages/${uid}/modify`,
					add ? { addLabelIds: [labelId] } : { removeLabelIds: [labelId] },
				);
			} else return { ok: false, reason: "unsupported_operation" };
		} else return { ok: false, reason: "invalid_target" };
		return { ok: true };
	} catch {
		return {
			ok: false,
			reason: submitted ? "may_not_have_gone_through" : "provider_error",
		};
	}
};
