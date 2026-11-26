import { z } from "zod";
import { microsoftCanWrite } from "$lib/shared/microsoft-permissions";
import { getConnection } from "../store";
import type { WriteExecutor } from "../write-executors";
import { microsoftGraphRequest } from "./microsoft-graph";
import { onedriveGetAccessTokenForRead } from "./onedrive";

import { outlookSendDraftSnapshot } from "./outlook-mail";

const composition = z.object({
	to: z.string(),
	cc: z.string().optional(),
	subject: z.string(),
	body: z.string(),
});
function recipients(value: string) {
	return value
		.split(/[,;]/)
		.map((s) => s.trim())
		.filter(Boolean)
		.map((raw) => {
			const address = raw.match(/^.*<([^<>]+)>$/)?.[1] ?? raw;
			return { emailAddress: { address: z.email().parse(address) } };
		});
}
function message(content: unknown, send = false) {
	const parsed = (send ? composition : composition.partial()).parse(content);
	const toRecipients =
		parsed.to === undefined ? undefined : recipients(parsed.to);
	if (send && !toRecipients?.length) throw new Error("Missing recipient");
	const result = {
		...(parsed.subject === undefined ? {} : { subject: parsed.subject }),
		...(parsed.body === undefined
			? {}
			: { body: { contentType: "Text", content: parsed.body } }),
		...(toRecipients === undefined ? {} : { toRecipients }),
		...(parsed.cc === undefined ? {} : { ccRecipients: recipients(parsed.cc) }),
	};
	if (!Object.keys(result).length) throw new Error("Missing draft changes");
	return result;
}
const idSchema = z
	.string()
	.min(1)
	.refine((value) => value !== "." && value !== "..");
export const executeOutlookMailWrite: WriteExecutor["execute"] = async (
	userId,
	connectionId,
	op,
	content,
	opts,
) => {
	const conn = await getConnection(userId, connectionId);
	const permission =
		op.action === "email.send" || op.action === "email.send_draft"
			? "send"
			: "email";
	if (
		conn?.provider !== "onedrive" ||
		conn.status !== "connected" ||
		!conn.allowWrites ||
		!conn.capabilities.includes("email") ||
		!microsoftCanWrite(conn, permission)
	)
		return { ok: false, reason: "writes_not_allowed" };
	let sendSubmitted = false;
	try {
		const payload = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(content));
		let method: "POST" | "PATCH" = "POST",
			path: string,
			body: unknown;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Prefer: 'IdType="ImmutableId"',
		};
		if (op.action === "email.send_draft") {
			const uid = idSchema.parse(payload.uid);
			if (uid !== op.target?.id) return { ok: false, reason: "invalid_target" };
			const current = await outlookSendDraftSnapshot(conn, uid, opts);
			if (JSON.stringify(current) !== JSON.stringify(payload))
				return { ok: false, reason: "target_changed" };
			const token = await onedriveGetAccessTokenForRead(conn, opts, "email");
			sendSubmitted = true;
			const res = await microsoftGraphRequest(
				token,
				"POST",
				`/me/messages/${encodeURIComponent(uid)}/send`,
				{
					...opts,
					headers: { Prefer: headers.Prefer, "If-Match": current.etag },
				},
			);
			return res.status === 202
				? { ok: true }
				: {
						ok: false,
						reason:
							res.status === 412
								? "target_changed"
								: "may_not_have_gone_through",
					};
		}
		if (op.action === "email.draft") {
			path = "/me/messages";
			body = message(payload);
		} else if (op.action === "email.send") {
			const mail = message(payload, true);
			if (payload.uid) {
				if (op.target?.id !== payload.uid)
					return { ok: false, reason: "invalid_target" };
				path =
					"/me/messages/" +
					encodeURIComponent(idSchema.parse(payload.uid)) +
					"/reply";
				body = { message: mail };
			} else {
				path = "/me/sendMail";
				body = { message: mail, saveToSentItems: true };
			}
		} else {
			const id = idSchema.parse(payload.uid);
			if (id !== op.target?.id) return { ok: false, reason: "invalid_target" };
			path = `/me/messages/${encodeURIComponent(id)}`;
			if (op.action === "email.trash") {
				path += "/move";
				body = { destinationId: "deleteditems" };
			} else if (op.action === "email.flag") {
				const p = z
					.object({ flag: z.enum(["seen", "flagged"]), value: z.boolean() })
					.parse(payload);
				method = "PATCH";
				body =
					p.flag === "seen"
						? { isRead: p.value }
						: { flag: { flagStatus: p.value ? "flagged" : "notFlagged" } };
			} else if (op.action === "email.edit_draft") {
				method = "PATCH";
				body = message(payload);
				headers["If-Match"] = z.string().min(1).parse(payload.etag);
			} else return { ok: false, reason: "unsupported_operation" };
		}
		const token = await onedriveGetAccessTokenForRead(conn, opts, "email");
		sendSubmitted = op.action === "email.send";
		const response = await microsoftGraphRequest(token, method, path, {
			...opts,
			headers,
			body: JSON.stringify(body),
		});
		return response.ok
			? { ok: true }
			: {
					ok: false,
					reason:
						response.status === 412
							? "target_changed"
							: response.status === 403 || response.status === 401
								? "needs_reauth"
								: sendSubmitted && response.status >= 500
									? "may_not_have_gone_through"
									: "provider_error",
				};
	} catch {
		return {
			ok: false,
			reason: sendSubmitted ? "may_not_have_gone_through" : "provider_error",
		};
	}
};
