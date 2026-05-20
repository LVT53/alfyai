export const DEFAULT_PREVIEW_PREWARM_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_PREVIEW_PREWARM_DELAY_MS = 120;
const DEFAULT_PREVIEW_PREWARM_MAX_CONCURRENCY = 2;
const DEFAULT_RECENT_TTL_MS = 60_000;

type Fetcher = typeof fetch;

export interface DocumentPreviewPrewarmTarget {
	previewUrl?: string | null;
	artifactId?: string | null;
	displayArtifactId?: string | null;
	sizeBytes?: number | null;
}

interface PrewarmOptions {
	fetcher?: Fetcher;
	maxBytes?: number;
	now?: () => number;
	prewarmDelayMs?: number;
	recentTtlMs?: number;
}

const inFlightUrls = new Set<string>();
const pendingUrls = new Set<string>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const recentUrls = new Map<string, number>();

async function consumePreviewResponseBody(
	response: Response,
	maxBytes: number,
): Promise<void> {
	const contentLengthHeader = response.headers.get("content-length");
	const contentLength =
		contentLengthHeader == null ? null : Number(contentLengthHeader);

	if (contentLength != null && Number.isFinite(contentLength)) {
		if (contentLength <= maxBytes) {
			await response.arrayBuffer();
			return;
		}
		await response.body?.cancel();
		return;
	}

	const reader = response.body?.getReader();
	if (!reader) {
		await response.arrayBuffer();
		return;
	}

	let bytesRead = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			bytesRead += value.byteLength;
			if (bytesRead >= maxBytes) {
				await reader.cancel();
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export function resetDocumentPreviewPrewarmCache() {
	for (const timer of pendingTimers.values()) {
		clearTimeout(timer);
	}
	inFlightUrls.clear();
	pendingUrls.clear();
	pendingTimers.clear();
	recentUrls.clear();
}

export function resolveDocumentPreviewUrl(
	target: DocumentPreviewPrewarmTarget,
): string | null {
	if (target.previewUrl) return target.previewUrl;
	const artifactId = target.artifactId ?? target.displayArtifactId;
	if (!artifactId) return null;
	return `/api/knowledge/${encodeURIComponent(artifactId)}/preview`;
}

export async function prewarmDocumentPreview(
	target: DocumentPreviewPrewarmTarget,
	options: PrewarmOptions = {},
): Promise<boolean> {
	const url = resolveDocumentPreviewUrl(target);
	if (!url) return false;

	const maxBytes = options.maxBytes ?? DEFAULT_PREVIEW_PREWARM_MAX_BYTES;
	if (target.sizeBytes != null && target.sizeBytes > maxBytes) return false;

	const now = options.now ?? Date.now;
	const timestamp = now();
	const recentTtlMs = options.recentTtlMs ?? DEFAULT_RECENT_TTL_MS;
	const recentTimestamp = recentUrls.get(url);
	if (
		pendingUrls.size + inFlightUrls.size >=
			DEFAULT_PREVIEW_PREWARM_MAX_CONCURRENCY ||
		pendingUrls.has(url) ||
		inFlightUrls.has(url) ||
		(recentTimestamp != null && timestamp - recentTimestamp < recentTtlMs)
	) {
		return false;
	}

	pendingUrls.add(url);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(async () => {
			pendingTimers.delete(url);
			pendingUrls.delete(url);
			inFlightUrls.add(url);
			try {
				const response = await (options.fetcher ?? fetch)(url, {
					credentials: "same-origin",
				});
				await consumePreviewResponseBody(response, maxBytes);
			} catch {
				// Prewarm is a latency hint only; opening the preview remains authoritative.
			} finally {
				inFlightUrls.delete(url);
				recentUrls.set(url, now());
				resolve(true);
			}
		}, options.prewarmDelayMs ?? DEFAULT_PREVIEW_PREWARM_DELAY_MS);
		pendingTimers.set(url, timer);
	});
}
