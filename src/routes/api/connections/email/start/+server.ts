import { handleCredentialConnect } from "$lib/server/api/connect";
import {
	ImapError,
	imapConnect,
} from "$lib/server/services/connections/providers/imap";
import type { RequestHandler } from "./$types";

type ImapConnectInput = {
	email: string;
	imapHost: string;
	password: string;
	imapPort?: number;
	imapSecure?: boolean;
	smtpHost?: string;
	smtpPort?: number;
};

// Validates an optional port field: undefined -> absent (undefined), else must
// be an integer in 1..65535. Returns null on an invalid value.
function parsePort(value: unknown): number | undefined | null {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return null;
	return parsed;
}

// POST /api/connections/email/start — no redirect flow (IMAP has no OAuth):
// the client posts the mailbox email + host/port/secure + a password (an app
// password for Gmail/iCloud, or the mailbox password for an own-domain
// account) and this route synchronously runs the whole connect+validate
// (LOGIN + SELECT INBOX) flow before responding.
export const POST: RequestHandler = (event) =>
	handleCredentialConnect<
		ImapConnectInput,
		Awaited<ReturnType<typeof imapConnect>>
	>({
		event,
		errorType: ImapError,
		fallbackError: "Failed to connect to the mailbox",
		parse: (body) => {
			const email = typeof body.email === "string" ? body.email.trim() : "";
			const imapHost =
				typeof body.imapHost === "string" ? body.imapHost.trim() : "";
			const password = typeof body.password === "string" ? body.password : "";
			if (!email || !imapHost || !password) {
				return {
					ok: false,
					error: "email, imapHost, and password are required",
				};
			}

			const imapPort = parsePort(body.imapPort);
			if (imapPort === null) {
				return { ok: false, error: "imapPort must be a valid port number" };
			}

			const imapSecure =
				typeof body.imapSecure === "boolean" ? body.imapSecure : undefined;

			let smtpHost: string | undefined;
			if (body.smtpHost !== undefined) {
				smtpHost =
					typeof body.smtpHost === "string" ? body.smtpHost.trim() : "";
			}

			const smtpPort = parsePort(body.smtpPort);
			if (smtpPort === null) {
				return { ok: false, error: "smtpPort must be a valid port number" };
			}

			return {
				ok: true,
				value: {
					email,
					imapHost,
					password,
					...(imapPort !== undefined ? { imapPort } : {}),
					...(imapSecure !== undefined ? { imapSecure } : {}),
					...(smtpHost ? { smtpHost } : {}),
					...(smtpPort !== undefined ? { smtpPort } : {}),
				},
			};
		},
		connect: ({ userId, value }) => imapConnect({ userId, ...value }),
	});
