import { handleOAuthConnectStart } from "$lib/server/api/connect";
import {
	GoogleOAuthError,
	googleConnectStart,
} from "$lib/server/services/connections/providers/google";
import type { RequestHandler } from "./$types";

// POST /api/connections/google/start — the client calls this to get the
// Google consent-screen URL to redirect to; the actual OAuth exchange
// happens in the callback route above.
export const POST: RequestHandler = (event) =>
	handleOAuthConnectStart({
		event,
		errorType: GoogleOAuthError,
		fallbackError: "Failed to start Google connect",
		connectStart: googleConnectStart,
	});
