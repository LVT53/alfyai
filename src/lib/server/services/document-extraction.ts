import { readFile } from 'fs/promises';
import { basename, extname } from 'path';
import { getConfig } from '../config-store';

interface ExtractionResult {
	text: string | null;
	normalizedName: string;
	mimeType: string;
}

function mimeFromExtension(ext: string): string | null {
	const map: Record<string, string> = {
		'.pdf': 'application/pdf',
		'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		'.odt': 'application/vnd.oasis.opendocument.text',
		'.doc': 'application/msword',
		'.xls': 'application/vnd.ms-excel',
		'.ppt': 'application/vnd.ms-powerpoint',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.gif': 'image/gif',
		'.bmp': 'image/bmp',
		'.webp': 'image/webp',
		'.tiff': 'image/tiff',
		'.tif': 'image/tiff',
		'.svg': 'image/svg+xml',
		'.heic': 'image/heic',
		'.heif': 'image/heif',
		'.avif': 'image/avif',
		'.txt': 'text/plain',
		'.md': 'text/markdown',
		'.html': 'text/html',
		'.htm': 'text/html',
		'.csv': 'text/csv',
		'.json': 'application/json',
		'.py': 'text/x-python',
		'.js': 'text/javascript',
		'.ts': 'application/typescript',
		'.css': 'text/css',
		'.yaml': 'application/yaml',
		'.yml': 'application/yaml',
		'.xml': 'application/xml',
	};
	return map[ext] ?? null;
}

function extractMdContent(data: unknown, originalName: string): string {
	if (!data || typeof data !== 'object') return '';

	const payload = data as Record<string, unknown>;
	const results = payload.results;
	if (!results || typeof results !== 'object') return '';

	const resultsObj = results as Record<string, unknown>;
	const docKey = basename(originalName, extname(originalName));
	const docResult = resultsObj[docKey] ?? Object.values(resultsObj)[0];

	if (!docResult || typeof docResult !== 'object') return '';
	const md = (docResult as Record<string, unknown>).md_content;
	return typeof md === 'string' ? md : '';
}

function toNormalizedName(originalName: string): string {
	const stem = basename(originalName, extname(originalName));
	return `${stem || 'document'}.md`;
}

function isDirectTextExtractionFile(ext: string, mimeType: string | null): boolean {
	const normalizedMime = mimeType?.toLowerCase() ?? '';
	return (
		normalizedMime.startsWith('text/') ||
		normalizedMime === 'application/json' ||
		normalizedMime === 'application/xml' ||
		normalizedMime === 'application/yaml' ||
		normalizedMime === 'application/typescript' ||
		[
			'.txt',
			'.md',
			'.markdown',
			'.html',
			'.htm',
			'.csv',
			'.json',
			'.py',
			'.js',
			'.ts',
			'.css',
			'.yaml',
			'.yml',
			'.xml',
		].includes(ext)
	);
}

export function resetDocumentExtractionExecutableCache(): void {
	// No persistent state with MinerU — each call is stateless HTTP.
	// Kept as a no-op to preserve the existing public API contract.
}

export async function extractDocumentText(
	filePath: string,
	_mimeType: string | null,
	originalName: string
): Promise<ExtractionResult> {
	const normalizedName = toNormalizedName(originalName);
	const startedAt = Date.now();
	const config = getConfig();

	try {
		const fileBuffer = await readFile(filePath);
		if (fileBuffer.length === 0) {
			console.error('[MINERU] empty_file', { filePath });
			return { text: null, normalizedName, mimeType: 'text/markdown' };
		}

		const ext = extname(originalName).toLowerCase();
		const mime = mimeFromExtension(ext) ?? 'application/octet-stream';
		if (isDirectTextExtractionFile(ext, _mimeType ?? mime)) {
			const text = fileBuffer.toString('utf8').trim();
			return {
				text: text || null,
				normalizedName,
				mimeType: 'text/markdown',
			};
		}

		const file = new File([fileBuffer], originalName, { type: mime });
		const formData = new FormData();
		formData.append('files', file);
		formData.append('return_md', 'true');
		formData.append('backend', 'hybrid-auto-engine');

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.mineruTimeoutMs);

		const response = await fetch(`${config.mineruApiUrl}/file_parse`, {
			method: 'POST',
			body: formData,
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (!response.ok) {
			const errorBody = await response.text().catch(() => null);
			console.error('[MINERU] request_failed', {
				filePath,
				status: response.status,
				durationMs: Date.now() - startedAt,
				errorBody: errorBody?.slice(0, 500) ?? null,
			});
			return { text: null, normalizedName, mimeType: 'text/markdown' };
		}

		const data = await response.json().catch(() => null);
		const markdown = extractMdContent(data, originalName);

		if (!markdown.trim()) {
			console.info('[MINERU] empty_result', {
				filePath,
				durationMs: Date.now() - startedAt,
			});
			return { text: null, normalizedName, mimeType: 'text/markdown' };
		}

		console.info('[MINERU] extraction_success', {
			filePath,
			durationMs: Date.now() - startedAt,
			textLength: markdown.length,
			textPreview: markdown.slice(0, 300),
		});

		return { text: markdown.trim(), normalizedName, mimeType: 'text/markdown' };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const timedOut =
			error instanceof DOMException && error.name === 'AbortError';

		console.error('[MINERU] extraction_error', {
			filePath,
			durationMs: Date.now() - startedAt,
			timedOut,
			message,
		});

		return { text: null, normalizedName, mimeType: 'text/markdown' };
	}
}
