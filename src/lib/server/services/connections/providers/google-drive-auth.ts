import type { ConnectionPublic } from "../store";
import {
	googleServiceAccessToken,
	googleServiceCanModify,
} from "./google-service-token";
export function googleDriveCanModify(connection: ConnectionPublic) {
	return googleServiceCanModify(connection, "files");
}
export function googleDriveGetAccessToken(
	connection: ConnectionPublic,
	opts?: { fetch?: typeof fetch },
	requiredScope: "read" | "modify" = "read",
) {
	return googleServiceAccessToken("files", connection, opts, requiredScope);
}
