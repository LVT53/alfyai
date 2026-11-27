import type { ConnectionPublic } from "../store";
import {
	googleServiceAccessToken,
	googleServiceCanModify,
} from "./google-service-token";
export function gmailCanModify(connection: ConnectionPublic) {
	return googleServiceCanModify(connection, "email");
}
export function gmailGetAccessToken(
	connection: ConnectionPublic,
	opts?: { fetch?: typeof fetch },
	requiredScope: "read" | "modify" = "read",
) {
	return googleServiceAccessToken("email", connection, opts, requiredScope);
}
