import {
	type ConnectionPublic,
	getConnection,
	getConnectionSecret,
} from "../store";
import { GoogleOAuthError, googleRefreshAccessToken } from "./google";
import {
	type OptionalGoogleCapability,
	optionalGoogleServices,
} from "./google-optional-services";
export function googleServiceCanModify(
	conn: ConnectionPublic,
	cap: OptionalGoogleCapability,
): boolean {
	return (
		conn.provider === "google" &&
		optionalGoogleServices[cap].enabled(conn.userId) &&
		conn.capabilities.includes(cap) &&
		conn.allowWrites &&
		conn.oauthScopes.includes(optionalGoogleServices[cap].writeScope)
	);
}
export async function googleServiceAccessToken(
	cap: OptionalGoogleCapability,
	conn: ConnectionPublic,
	opts?: { fetch?: typeof fetch },
	requiredScope: "read" | "modify" = "read",
): Promise<string> {
	const current = await getConnection(conn.userId, conn.id);
	if (
		current?.provider !== "google" ||
		current.status !== "connected" ||
		!optionalGoogleServices[cap].enabled(current.userId) ||
		!current.capabilities.includes(cap) ||
		!optionalGoogleServices[cap].canRead(current.oauthScopes) ||
		(requiredScope === "modify" && !googleServiceCanModify(current, cap))
	)
		throw new GoogleOAuthError(
			"Access to this Google service is unavailable",
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
