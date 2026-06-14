const COMPLETIONS_ENDPOINT_PATTERN = /\/(?:v\d+\/)?chat\/completions$/i;
const MODELS_ENDPOINT_PATTERN = /\/models$/i;
const VERSIONED_BASE_PATTERN = /\/v\d+$/i;

export function normalizeOpenAICompatibleBaseUrl(baseUrl: string): string {
	let base = baseUrl.trim().replace(/\/+$/, "");
	if (!base) {
		return base;
	}

	base = base.replace(COMPLETIONS_ENDPOINT_PATTERN, "");
	base = base.replace(MODELS_ENDPOINT_PATTERN, "");

	if (VERSIONED_BASE_PATTERN.test(base)) {
		return base;
	}

	return `${base}/v1`;
}

export function buildOpenAICompatibleUrl(
	baseUrl: string,
	path: string,
): string {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	const base = normalizedPath.toLowerCase().startsWith("/v1/")
		? normalizeOpenAICompatibleBaseUrl(baseUrl)
		: baseUrl.trim().replace(/\/+$/, "");

	if (/\/v1$/i.test(base) && normalizedPath.toLowerCase().startsWith("/v1/")) {
		return `${base}${normalizedPath.slice("/v1".length)}`;
	}

	return `${base}${normalizedPath}`;
}
