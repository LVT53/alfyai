import { bearerAuthHeader, providerFetch } from "../provider-http";

export async function microsoftGraphRequest(
	token: string,
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
	path: string,
	options: {
		fetch?: typeof fetch;
		body?: string;
		headers?: Record<string, string>;
	} = {},
): Promise<Response> {
	const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
	if (
		!path.startsWith("/me/") ||
		!url.pathname.startsWith("/v1.0/me/") ||
		url.hash ||
		path.includes("\\") ||
		/(?:^|\/)(?:\.|%2e){1,2}(?:\/|\?|$)/i.test(path)
	) {
		throw new Error("Invalid Microsoft Graph account path");
	}
	return providerFetch(url.toString(), {
		method,
		redirect: "error",
		headers: { ...options.headers, ...bearerAuthHeader(token) },
		body: options.body,
		fetch: options.fetch,
	});
}
