import { gmailPilotEnabled } from "$lib/server/env";
import { GMAIL_MODIFY_SCOPE, gmailReadGranted } from "$lib/shared/gmail-scopes";
import {
	type ConnectionPublic,
	getConnection,
	getConnectionSecret,
} from "../store";
import { GoogleOAuthError, googleRefreshAccessToken } from "./google";
export function gmailCanModify(conn: ConnectionPublic): boolean {
	return (
		conn.provider === "google" &&
		gmailPilotEnabled(conn.userId) &&
		conn.capabilities.includes("email") &&
		conn.allowWrites &&
		conn.oauthScopes.includes(GMAIL_MODIFY_SCOPE)
	);
}
export async function gmailGetAccessToken(
	conn: ConnectionPublic,
	opts?: { fetch?: typeof fetch },
	requiredScope: "read" | "modify" = "read",
): Promise<string> {
	const current = await getConnection(conn.userId, conn.id);
	if (
		current?.provider !== "google" ||
		current.status !== "connected" ||
		!gmailPilotEnabled(current.userId) ||
		!current.capabilities.includes("email") ||
		!gmailReadGranted(current.oauthScopes) ||
		(requiredScope === "modify" && !gmailCanModify(current))
	)
		throw new GoogleOAuthError(
			"Gmail access is unavailable",
			"invalid_write_target",
		);
	if (
		current.tokenExpiresAt &&
		current.tokenExpiresAt > Date.now() / 1000 + 60
	) {
		const raw = await getConnectionSecret(current.userId, current.id);
		if (raw) {
			const { accessToken } = JSON.parse(raw);
			if (typeof accessToken === "string" && accessToken) return accessToken;
		}
	}
	return googleRefreshAccessToken(current.userId, current.id, opts);
}
