<script lang="ts">
import { browser } from "$app/environment";
import { t } from "$lib/i18n";
import { sanitizeHtml } from "$lib/utils/html-sanitizer";
import type { PreviewFileType } from "$lib/utils/file-preview";
import { tick } from "svelte";
import DocumentPreviewToolbar from "./DocumentPreviewToolbar.svelte";
import { AlertCircle, FileText } from "@lucide/svelte";
import {
	loadImagePreviewComponent,
	loadPdfPreviewComponent,
	loadPreviewRuntime,
	renderPreviewOfficeAdapter,
	renderPreviewTextAdapter,
	resolvePreviewSourceUrl,
	type ImagePreviewComponent as ImagePreviewComponentType,
	type OfficePreviewReady,
	type PdfPreviewComponent as PdfPreviewComponentType,
	type PreviewRuntimeAdapter,
} from "./preview-runtime";
import type { TextPreviewRenderResult } from "./preview-runtime/text";

let {
	open,
	artifactId,
	previewUrl = null,
	filename,
	mimeType,
	onClose = () => undefined,
	currentPage = $bindable(1),
	totalPages = $bindable(0),
}: {
	open: boolean;
	artifactId: string | null;
	previewUrl?: string | null;
	filename: string;
	mimeType: string | null;
	onClose?: () => void;
	currentPage?: number;
	totalPages?: number;
} = $props();

let content = $state<Blob | null>(null);
let adapter = $state<PreviewRuntimeAdapter | null>(null);
let textPreview = $state<TextPreviewRenderResult | null>(null);
let officePreview = $state<OfficePreviewReady | null>(null);
let isLoading = $state(false);
let error = $state<string | null>(null);
let fileType = $state<PreviewFileType>("unsupported");
let officePreviewRef = $state<HTMLDivElement | null>(null);
let missingPreviewSource = $state(false);
let PdfPreviewComponent = $state<PdfPreviewComponentType | null>(null);
let ImagePreviewComponent = $state<ImagePreviewComponentType | null>(null);
let previewLoadToken = 0;

$effect(() => {
	const previewSourceUrl = resolvePreviewSourceUrl({ artifactId, previewUrl });
	if (open && previewSourceUrl) {
		startPreviewLoad();
		return () => {
			invalidatePreviewLoad();
		};
	}

	invalidatePreviewLoad();
	resetPreviewState();
	isLoading = false;

	if (open) {
		missingPreviewSource = true;
	}
});

$effect(() => {
	if (
		fileType !== "pptx" ||
		!officePreview ||
		!officePreviewRef ||
		currentPage < 1 ||
		totalPages <= 0
	) {
		return;
	}

	const targetPage = Math.max(1, Math.min(currentPage, totalPages));
	void tick().then(() => {
		if (
			fileType !== "pptx" ||
			!officePreviewRef ||
			currentPage !== targetPage
		) {
			return;
		}
		const slide =
			officePreviewRef.querySelectorAll<HTMLElement>(".pptx-slide")[
				targetPage - 1
			];
		slide?.scrollIntoView?.({ behavior: "smooth", block: "start" });
	});
});

function resetPreviewState() {
	content = null;
	adapter = null;
	textPreview = null;
	officePreview = null;
	error = null;
	fileType = "unsupported";
	missingPreviewSource = false;
	PdfPreviewComponent = null;
	ImagePreviewComponent = null;
	currentPage = 1;
	totalPages = 0;
}

function invalidatePreviewLoad() {
	previewLoadToken += 1;
}

function startPreviewLoad() {
	const loadToken = ++previewLoadToken;
	void fetchFile(loadToken);
}

function isStalePreviewLoad(loadToken: number): boolean {
	return loadToken !== previewLoadToken;
}

async function fetchFile(loadToken: number) {
	isLoading = true;
	resetPreviewState();

	try {
		const result = await loadPreviewRuntime({
			artifactId,
			previewUrl,
			filename,
			mimeType,
		});

		if (isStalePreviewLoad(loadToken)) return;

		if (result.status === "error") {
			throw new Error(result.error);
		}

		content = result.blob;
		adapter = result.adapter;
		fileType = result.fileType;

		if (result.adapter.kind === "text" || result.adapter.kind === "html") {
			const renderedText = await renderPreviewTextAdapter(result.adapter, {
				isDark: isDarkTheme(),
			});
			if (isStalePreviewLoad(loadToken)) return;
			textPreview = renderedText;
			return;
		}

		if (result.adapter.kind === "pdf") {
			const PdfComponent = await loadPdfPreviewComponent();
			if (isStalePreviewLoad(loadToken)) return;
			PdfPreviewComponent = PdfComponent;
			return;
		}

		if (result.adapter.kind === "image") {
			const ImageComponent = await loadImagePreviewComponent();
			if (isStalePreviewLoad(loadToken)) return;
			ImagePreviewComponent = ImageComponent;
			return;
		}

		if (isOfficeAdapter(result.adapter)) {
			const renderedOffice = await renderPreviewOfficeAdapter(result.adapter);
			if (isStalePreviewLoad(loadToken)) return;
			if (renderedOffice.status === "error") {
				throw new Error(renderedOffice.error);
			}
			officePreview = renderedOffice;
			if (renderedOffice.kind === "pptx") {
				totalPages = renderedOffice.totalPages ?? 0;
				currentPage = renderedOffice.currentPage ?? 1;
			}
		}
	} catch (err) {
		if (isStalePreviewLoad(loadToken)) return;
		error = err instanceof Error ? err.message : "Failed to load file";
	} finally {
		if (!isStalePreviewLoad(loadToken)) {
			isLoading = false;
		}
	}
}

function isDarkTheme(): boolean {
	return browser
		? (document?.documentElement?.classList.contains("dark") ?? false)
		: false;
}

function isOfficeAdapter(
	nextAdapter: PreviewRuntimeAdapter,
): nextAdapter is Extract<
	PreviewRuntimeAdapter,
	{ kind: "docx" | "xlsx" | "pptx" | "odt" }
> {
	return (
		nextAdapter.kind === "docx" ||
		nextAdapter.kind === "xlsx" ||
		nextAdapter.kind === "pptx" ||
		nextAdapter.kind === "odt"
	);
}

function reportAdapterError(message: string) {
	error = message;
}

function downloadFile() {
	if (!content) return;
	const url = URL.createObjectURL(content);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}
</script>

{#if open}
	{#snippet PreviewPanel()}
		<div
			role="region"
			aria-label={filename}
			class:preview-panel={true}
			class:preview-panel-embedded={true}
		>
			<div class:preview-body={true} class:preview-body-embedded={true}>
				{#if isLoading}
					<div class="flex flex-col items-center justify-center py-16 gap-4">
						<div class="spinner"></div>
						<p class="text-sm text-text-muted">{$t("filePreview.loading")}</p>
					</div>
				{:else if error}
					<div class="m-6 rounded-[1rem] border border-danger/30 bg-danger/10 px-4 py-6 text-center">
						<AlertCircle class="mx-auto mb-3 text-danger" size={32} strokeWidth={2} aria-hidden="true" />
						<p class="text-sm font-sans text-danger mb-2">{error}</p>
						<button
							type="button"
							class="btn-secondary mt-2"
							onclick={startPreviewLoad}
						>
							{$t("filePreview.retry")}
						</button>
					</div>
				{:else if missingPreviewSource}
					<div class="m-6 rounded-[1.2rem] border border-dashed border-border bg-surface-page px-6 py-8 text-center">
						<FileText class="mx-auto mb-3 text-icon-muted" size={40} strokeWidth={1.5} aria-hidden="true" />
						<p class="text-sm text-text-muted">{$t("filePreview.notAvailable")}</p>
					</div>
				{:else if fileType === "unsupported"}
					<div class="m-6 rounded-[1.2rem] border border-dashed border-border bg-surface-page px-6 py-8 text-center">
						<FileText class="mx-auto mb-3 text-icon-muted" size={40} strokeWidth={1.5} aria-hidden="true" />
						<p class="text-sm text-text-muted mb-1">{$t("filePreview.notAvailableType")}</p>
						<p class="text-xs text-text-muted/70 mb-4">{$t("filePreview.downloadToView")}</p>
						{#if content}
							<button
								type="button"
								class="btn-primary"
								onclick={downloadFile}
							>
								{$t("filePreview.downloadFile")}
							</button>
						{/if}
					</div>
				{:else if fileType === "pdf"}
					{#if content && adapter?.kind === "pdf" && PdfPreviewComponent}
						<PdfPreviewComponent
							blob={content}
							{filename}
							bind:currentPage
							bind:totalPages
							onError={reportAdapterError}
						/>
					{/if}
				{:else if fileType === "image"}
					{#if content && adapter?.kind === "image" && ImagePreviewComponent}
						<ImagePreviewComponent blob={content} {filename} />
					{/if}
				{:else if fileType === "text"}
					{#if textPreview}
						<div class="p-6">
							{#if textPreview.kind === "csv"}
								<div class="csv-table-container">
									{@html sanitizeHtml(textPreview.html)}
								</div>
							{:else if textPreview.kind === "markdown"}
								<div class="markdown-document-preview">
									{@html textPreview.html}
								</div>
							{:else if textPreview.kind === "highlighted"}
								<div class="file-text-preview">
									{@html textPreview.html}
								</div>
							{/if}
						</div>
					{/if}
				{:else if fileType === "html"}
					{#if textPreview?.kind === "html"}
						<div class="html-preview-shell" style="height: 100%;">
							<iframe
								class="html-preview-frame"
								title={`${filename} preview`}
								sandbox=""
								style="height: 100%; flex-grow: 1;"
								srcdoc={textPreview.srcdoc}
							></iframe>
						</div>
					{/if}
				{:else if fileType === "docx" || fileType === "xlsx" || fileType === "pptx" || fileType === "odt"}
					{#if officePreview}
						{#if officePreview.kind === "pptx" && totalPages > 0}
							<DocumentPreviewToolbar
								pageKind="slide"
								bind:currentPage
								{totalPages}
							/>
						{/if}
						<div class="p-6 docx-preview" bind:this={officePreviewRef}>
							{@html sanitizeHtml(officePreview.html)}
						</div>
					{/if}
				{:else}
					<div class="m-6 rounded-[1.2rem] border border-dashed border-border bg-surface-page px-4 py-5 text-center">
						<p class="text-sm text-text-muted">{$t("filePreview.notAvailable")}</p>
					</div>
				{/if}
			</div>
		</div>
	{/snippet}

	<div class="preview-embedded-shell">
		{@render PreviewPanel()}
	</div>
{/if}

<style>
	.spinner {
		width: 40px;
		height: 40px;
		border: 3px solid color-mix(in srgb, var(--border-default) 50%, transparent);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	:global(.docx-preview) {
		font-family: 'Libre Baskerville', serif;
		line-height: 1.6;
		color: var(--text-primary);
	}

	:global(.docx-preview h1),
	:global(.docx-preview h2),
	:global(.docx-preview h3),
	:global(.docx-preview h4) {
		font-family: 'Nimbus Sans L', sans-serif;
		margin-top: 1.5em;
		margin-bottom: 0.5em;
	}

	:global(.docx-preview p) {
		margin-bottom: 1em;
	}

	:global(.docx-preview ul) {
		margin: 1em 0;
		padding-left: 1.25rem;
		list-style: disc;
	}

	:global(.docx-preview table) {
		width: 100%;
		border-collapse: collapse;
		margin: 1em 0;
	}

	:global(.docx-preview td),
	:global(.docx-preview th) {
		border: 1px solid var(--border-default);
		padding: 0.5em;
		text-align: left;
	}

	:global(.xlsx-container) {
		font-family: 'Nimbus Sans L', sans-serif;
	}

	:global(.xlsx-container .sheet) {
		margin-bottom: 2em;
	}

	:global(.xlsx-container .sheet h4) {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 0.5em;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	:global(.xlsx-table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	:global(.xlsx-table td),
	:global(.xlsx-table th) {
		border: 1px solid var(--border-default);
		padding: 0.5rem 0.75rem;
		text-align: left;
	}

	:global(.xlsx-table tr:first-child td) {
		background: var(--surface-overlay);
		font-weight: 600;
	}

	:global(.xlsx-table tr:nth-child(even)) {
		background: color-mix(in srgb, var(--surface-page) 50%, transparent);
	}

	:global(.pptx-container) {
		font-family: 'Nimbus Sans L', sans-serif;
		min-width: 0;
		max-width: 58rem;
		margin: 0 auto;
	}

	:global(.pptx-slide) {
		background: transparent;
		min-width: 0;
		scroll-margin-top: var(--preview-toolbar-jump-offset);
	}

	:global(.pptx-slide-frame) {
		position: relative;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: 0.55rem;
		background: #ffffff;
		box-shadow: 0 0.75rem 1.8rem rgba(0, 0, 0, 0.08);
	}

	:global(.pptx-slide-badge) {
		position: absolute;
		right: 0.55rem;
		bottom: 0.55rem;
		border: 1px solid color-mix(in srgb, #ffffff 72%, #1b1815 28%);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.88);
		padding: 0.18rem 0.5rem;
		font-size: 0.75rem;
		font-weight: 700;
		line-height: 1.2;
		color: #3e3933;
		backdrop-filter: blur(6px);
	}

	:global(.pptx-slide-separator) {
		position: relative;
		height: 1.05rem;
		margin: 0.22rem 0;
	}

	:global(.pptx-slide-separator::before),
	:global(.pptx-slide-separator::after) {
		content: "";
		position: absolute;
		left: 50%;
		transform: translateX(-50%);
	}

	:global(.pptx-slide-separator::before) {
		top: 0;
		bottom: 0;
		width: 1px;
		background: linear-gradient(
			180deg,
			transparent,
			color-mix(in srgb, var(--border-default) 76%, var(--text-primary) 24%),
			transparent
		);
	}

	:global(.pptx-slide-separator::after) {
		top: 50%;
		width: 0.38rem;
		height: 0.38rem;
		border: 1px solid var(--border-default);
		border-radius: 999px;
		background: var(--surface-page);
		transform: translate(-50%, -50%);
	}

	:global(.pptx-slide-image) {
		display: block;
		width: 100%;
		height: auto;
		background: #ffffff;
	}

	:global(.file-text-preview .shiki),
	:global(.file-text-preview pre) {
		margin: 0;
		border: 1px solid var(--border-default);
		border-radius: 1rem;
		padding: 1rem;
		overflow-x: hidden;
		font-size: 0.875rem;
		line-height: 1.6;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		word-break: break-word;
	}

	:global(.file-text-preview code) {
		font-family: var(--font-mono, 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace);
		white-space: pre-wrap;
		overflow-wrap: break-word;
		word-break: break-word;
	}

	:global(.csv-table-container) {
		font-family: 'Nimbus Sans L', sans-serif;
		overflow-x: auto;
	}

	:global(.csv-table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	:global(.csv-table td),
	:global(.csv-table th) {
		border: 1px solid var(--border-default);
		padding: 0.5rem 0.75rem;
		text-align: left;
	}

	:global(.csv-table tr:first-child td) {
		background: var(--surface-overlay);
		font-weight: 600;
	}

	:global(.csv-table tr:nth-child(even)) {
		background: color-mix(in srgb, var(--surface-page) 50%, transparent);
	}

	:global(.markdown-document-preview) {
		max-width: 72ch;
		margin: 0 auto;
		font-family: 'Libre Baskerville', serif;
		font-size: 0.96rem;
		line-height: 1.72;
		color: var(--text-primary);
	}

	:global(.markdown-document-preview h1),
	:global(.markdown-document-preview h2),
	:global(.markdown-document-preview h3),
	:global(.markdown-document-preview h4),
	:global(.markdown-document-preview h5),
	:global(.markdown-document-preview h6) {
		font-family: 'Nimbus Sans L', sans-serif;
		font-weight: 700;
		line-height: 1.25;
		color: var(--text-primary);
	}

	:global(.markdown-document-preview h1) {
		margin: 0 0 1.1rem;
		font-size: 1.75rem;
	}

	:global(.markdown-document-preview h2) {
		margin: 2rem 0 0.8rem;
		padding-bottom: 0.35rem;
		border-bottom: 1px solid var(--border-subtle);
		font-size: 1.28rem;
	}

	:global(.markdown-document-preview h3) {
		margin: 1.55rem 0 0.6rem;
		font-size: 1.08rem;
	}

	:global(.markdown-document-preview h4),
	:global(.markdown-document-preview h5),
	:global(.markdown-document-preview h6) {
		margin: 1.25rem 0 0.5rem;
		font-size: 0.95rem;
	}

	:global(.markdown-document-preview p) {
		margin: 0 0 1rem;
	}

	:global(.markdown-document-preview ul),
	:global(.markdown-document-preview ol) {
		margin: 0.7rem 0 1rem;
		padding-left: 1.45rem;
	}

	:global(.markdown-document-preview ul) {
		list-style: disc;
	}

	:global(.markdown-document-preview ol) {
		list-style: decimal;
	}

	:global(.markdown-document-preview li) {
		margin: 0.28rem 0;
		padding-left: 0.2rem;
	}

	:global(.markdown-document-preview li > input[type='checkbox']) {
		margin-right: 0.45rem;
		transform: translateY(0.08rem);
	}

	:global(.markdown-document-preview blockquote) {
		margin: 1.1rem 0;
		padding: 0.05rem 0 0.05rem 1rem;
		border-left: 3px solid var(--border-strong);
		color: var(--text-secondary);
	}

	:global(.markdown-document-preview a) {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 0.18em;
	}

	:global(.markdown-document-preview code) {
		font-family: var(--font-mono, 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace);
		font-size: 0.9em;
	}

	:global(.markdown-document-preview :not(pre) > code) {
		border: 1px solid var(--border-subtle);
		border-radius: 0.28rem;
		padding: 0.08rem 0.28rem;
		background: color-mix(in srgb, var(--surface-elevated) 70%, var(--surface-page) 30%);
	}

	:global(.markdown-document-preview pre) {
		margin: 1rem 0;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		padding: 0.85rem 1rem;
		overflow-x: auto;
		font-size: 0.84rem;
		line-height: 1.55;
	}

	:global(.markdown-table-wrap) {
		margin: 1rem 0 1.25rem;
		overflow-x: auto;
	}

	:global(.markdown-table) {
		width: 100%;
		border-collapse: collapse;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.86rem;
	}

	:global(.markdown-table th),
	:global(.markdown-table td) {
		border: 1px solid var(--border-default);
		padding: 0.5rem 0.68rem;
		text-align: left;
		vertical-align: top;
	}

	:global(.markdown-table th) {
		background: var(--surface-elevated);
		font-weight: 700;
	}

	:global(.markdown-frontmatter),
	:global(.markdown-callout) {
		margin: 0 0 1.15rem;
		border: 1px solid var(--border-default);
		border-radius: 0.55rem;
		background: color-mix(in srgb, var(--surface-elevated) 58%, var(--surface-page) 42%);
		font-family: 'Nimbus Sans L', sans-serif;
	}

	:global(.markdown-frontmatter) {
		padding: 0.65rem 0.75rem;
	}

	:global(.markdown-frontmatter dl) {
		display: grid;
		gap: 0.34rem;
		margin: 0;
	}

	:global(.markdown-frontmatter-row) {
		display: grid;
		grid-template-columns: minmax(6rem, 0.32fr) minmax(0, 1fr);
		gap: 0.75rem;
	}

	:global(.markdown-frontmatter dt),
	:global(.markdown-frontmatter dd) {
		margin: 0;
		font-size: 0.78rem;
	}

	:global(.markdown-frontmatter dt) {
		font-weight: 700;
		color: var(--text-muted);
	}

	:global(.markdown-callout) {
		padding: 0.8rem 0.9rem;
		border-left: 3px solid var(--border-strong);
	}

	:global(.markdown-callout-title) {
		margin-bottom: 0.4rem;
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-secondary);
	}

	:global(.markdown-callout-body > :last-child) {
		margin-bottom: 0;
	}

	.html-preview-shell {
		display: flex;
		min-height: 0;
		height: 100%;
		flex: 1 1 auto;
		padding: 1rem;
		background: var(--surface-page);
	}

	.html-preview-frame {
		flex: 1 1 auto;
		min-height: 0;
		height: 100%;
		width: 100%;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		background: #ffffff;
	}

	.preview-embedded-shell {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
		background: var(--surface-page);
	}

	.preview-panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		background: var(--surface-elevated);
	}

	.preview-panel-embedded {
		flex: 1 1 auto;
		border: none;
		background: var(--surface-page);
		min-height: 0;
	}

	.preview-body {
		--preview-toolbar-jump-offset: 4rem;
		min-height: 0;
		min-width: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}

	.preview-body-embedded {
		flex: 1 1 auto;
		overflow-y: auto;
		touch-action: pan-y;
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
</style>
