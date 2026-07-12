import { handleOAuthConnectStart } from "$lib/server/api/connect";
import {
	OneDriveError,
	onedriveConnectStart,
} from "$lib/server/services/connections/providers/onedrive";
import type { RequestHandler } from "./$types";

// POST /api/connections/onedrive/start — the client calls this to get the
// Microsoft consent-screen URL to redirect to; the actual OAuth exchange
// happens in the callback route (src/routes/api/oauth/onedrive/callback).
// Shares handleOAuthConnectStart with google/start (they were byte-for-byte
// twins), swapped to the OneDrive adapter.
export const POST: RequestHandler = (event) =>
	handleOAuthConnectStart({
		event,
		errorType: OneDriveError,
		fallbackError: "Failed to start OneDrive connect",
		connectStart: onedriveConnectStart,
	});
