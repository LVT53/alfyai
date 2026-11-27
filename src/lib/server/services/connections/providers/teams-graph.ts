import { bearerAuthHeader, providerFetch } from "../provider-http";

function segment(id: string) {
	if (
		!id ||
		id.length > 1024 ||
		id === "." ||
		id === ".." ||
		/[^A-Za-z0-9:@._!~-]/.test(id)
	) {
		throw new Error("Invalid Teams resource identifier");
	}
	return encodeURIComponent(id);
}

export function teamsChannelFilesFolder(
	token: string,
	teamId: string,
	channelId: string,
	opts: { fetch?: typeof fetch } = {},
) {
	return providerFetch(
		`https://graph.microsoft.com/v1.0/teams/${segment(teamId)}/channels/${segment(channelId)}/filesFolder`,
		{
			method: "GET",
			redirect: "error",
			headers: bearerAuthHeader(token),
			fetch: opts.fetch,
		},
	);
}
