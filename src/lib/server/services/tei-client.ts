import { getConfig } from "$lib/server/config-store";

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

export async function postToTei<T>(params: {
	baseUrl: string;
	path: string;
	apiKey?: string;
	body: Record<string, unknown>;
}): Promise<T> {
	const { teiTimeoutMs } = getConfig();
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), teiTimeoutMs);

	try {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (params.apiKey) {
			headers.Authorization = `Bearer ${params.apiKey}`;
		}

		const response = await fetch(
			`${trimTrailingSlash(params.baseUrl)}${params.path}`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(params.body),
				signal: controller.signal,
			},
		);

		if (!response.ok) {
			const bodyText = await response.text().catch(() => "");
			const detail = bodyText.trim() ? ` ${bodyText.trim().slice(0, 200)}` : "";
			throw new Error(
				`TEI request failed: ${response.status} ${response.statusText}${detail}`,
			);
		}

		return (await response.json()) as T;
	} finally {
		clearTimeout(timeoutId);
	}
}
