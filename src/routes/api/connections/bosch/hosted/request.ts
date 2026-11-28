import { error } from "@sveltejs/kit";

export {
	privateSetupHeaders as privateHeaders,
	readSetupRequest,
} from "$lib/server/api/connection-setup";

export const stateCookie = "bosch_hosted_state";
export const callbackPath = "/api/connections/bosch/hosted/callback";
export function callbackUrl(url: URL) {
	if (
		url.protocol !== "https:" &&
		!(
			url.protocol === "http:" &&
			["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
		)
	) {
		error(400, "Bosch setup requires HTTPS");
	}
	return new URL(callbackPath, url.origin);
}
