import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	ImapError,
	imapConnect,
} from "$lib/server/services/connections/providers/imap";
import type { RequestHandler } from "./$types";

// POST /api/connections/email/start — no redirect flow (IMAP has no OAuth):
// the client posts the mailbox email + host/port/secure + a password (an app
// password for Gmail/iCloud, or the mailbox password for an own-domain
// account) and this route synchronously runs the whole connect+validate
// (LOGIN + SELECT INBOX) flow before responding.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let body: {
		email?: unknown;
		imapHost?: unknown;
		imapPort?: unknown;
		imapSecure?: unknown;
		password?: unknown;
		smtpHost?: unknown;
		smtpPort?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const email = typeof body.email === "string" ? body.email.trim() : "";
	const imapHost =
		typeof body.imapHost === "string" ? body.imapHost.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	if (!email || !imapHost || !password) {
		return json(
			{ error: "email, imapHost, and password are required" },
			{ status: 400 },
		);
	}

	let imapPort: number | undefined;
	if (body.imapPort !== undefined) {
		const parsed = Number(body.imapPort);
		if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
			return json(
				{ error: "imapPort must be a valid port number" },
				{
					status: 400,
				},
			);
		}
		imapPort = parsed;
	}

	const imapSecure =
		typeof body.imapSecure === "boolean" ? body.imapSecure : undefined;

	let smtpHost: string | undefined;
	if (body.smtpHost !== undefined) {
		smtpHost = typeof body.smtpHost === "string" ? body.smtpHost.trim() : "";
	}
	let smtpPort: number | undefined;
	if (body.smtpPort !== undefined) {
		const parsed = Number(body.smtpPort);
		if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
			return json(
				{ error: "smtpPort must be a valid port number" },
				{
					status: 400,
				},
			);
		}
		smtpPort = parsed;
	}

	try {
		const result = await imapConnect({
			userId: user.id,
			email,
			imapHost,
			...(imapPort !== undefined ? { imapPort } : {}),
			...(imapSecure !== undefined ? { imapSecure } : {}),
			password,
			...(smtpHost ? { smtpHost } : {}),
			...(smtpPort !== undefined ? { smtpPort } : {}),
		});
		return json(result);
	} catch (err) {
		const status =
			err instanceof ImapError &&
			(err.code === "invalid_credentials" || err.code === "invalid_config")
				? err.code === "invalid_credentials"
					? 401
					: 400
				: 502;
		return json(
			{
				error:
					err instanceof ImapError
						? err.message
						: "Failed to connect to the mailbox",
			},
			{ status },
		);
	}
};
