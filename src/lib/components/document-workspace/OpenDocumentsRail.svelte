<script lang="ts">
import type { DocumentWorkspaceItem } from "$lib/types";
import FileTypeIcon from "$lib/components/ui/FileTypeIcon.svelte";
import { determinePreviewFileType } from "$lib/utils/file-preview";
import { t } from "$lib/i18n";
import { ArrowUpRight, Sparkles, X } from "@lucide/svelte";

let {
	documents,
	activeDocumentId,
	onSelectDocument,
	onJumpToSource = undefined,
	onCloseDocument,
}: {
	documents: DocumentWorkspaceItem[];
	activeDocumentId: string | null;
	onSelectDocument: (documentId: string) => void;
	onJumpToSource?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onCloseDocument: (documentId: string) => void;
} = $props();

function formatRoleLabel(role: string | null | undefined): string | null {
	if (!role) return null;
	const normalized = role.trim();
	if (!normalized) return null;
	return normalized
		.split(/[_-\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function getDocumentTitle(document: DocumentWorkspaceItem): string {
	return document.documentLabel ?? document.title ?? document.filename;
}

function getDocumentVersionLabel(
	document: DocumentWorkspaceItem,
): string | null {
	const versionNumber =
		document.versionNumber && document.versionNumber > 0
			? document.versionNumber
			: document.source === "chat_generated_file"
				? 1
				: null;
	return versionNumber ? `v${versionNumber}` : null;
}

function isAiGeneratedDocument(document: DocumentWorkspaceItem): boolean {
	return document.source === "chat_generated_file";
}

function canJumpToSource(document: DocumentWorkspaceItem): boolean {
	return Boolean(
		onJumpToSource &&
			document.originConversationId &&
			document.originAssistantMessageId,
	);
}

function handleSelectKeydown(event: KeyboardEvent, documentId: string) {
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	onSelectDocument(documentId);
}

function handleJumpToSource(event: MouseEvent, document: DocumentWorkspaceItem) {
	event.stopPropagation();
	onJumpToSource?.(document);
}

function getDocumentSourceLabel(document: DocumentWorkspaceItem): string {
	return isAiGeneratedDocument(document)
		? $t("documentWorkspace.aiSource")
		: $t("documentWorkspace.fromKnowledgeBase");
}

function getDocumentDetailMetadata(document: DocumentWorkspaceItem): string {
	return (
		[
			determinePreviewFileType(document.mimeType, document.filename).toUpperCase(),
			formatRoleLabel(document.documentRole),
		]
			.filter(Boolean)
			.join(" • ")
	);
}
</script>

{#if documents.length > 1}
	<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
	<nav
		class="open-documents-rail"
		role="tablist"
		aria-label={$t('documentWorkspace.openDocuments')}
		data-testid="open-documents-rail"
	>
		<div class="open-documents-rail-head">
			<span>{$t('documentWorkspace.openDocuments')}</span>
			<span aria-label={$t('documentWorkspace.openDocumentsCount', { count: documents.length })}>{documents.length}</span>
		</div>
		{#each documents as document (document.id)}
			<div class="open-documents-rail-row" class:open-documents-rail-row-active={document.id === activeDocumentId}>
				<div
					role="tab"
					tabindex="0"
					class="open-documents-rail-tab"
					aria-selected={document.id === activeDocumentId}
					onclick={() => onSelectDocument(document.id)}
					onkeydown={(event) => handleSelectKeydown(event, document.id)}
				>
					<span class="open-documents-rail-icon">
						<FileTypeIcon type={determinePreviewFileType(document.mimeType, document.filename)} />
					</span>
					<span class="open-documents-rail-text">
						<span class="open-documents-rail-title-row">
							<span class="open-documents-rail-title-source">
								<span class="open-documents-rail-title">{getDocumentTitle(document)}</span>
								{#if canJumpToSource(document)}
									<button
										type="button"
										class="open-documents-rail-source-jump"
										onclick={(event) => handleJumpToSource(event, document)}
										onkeydown={(event) => event.stopPropagation()}
										aria-label={$t('documentWorkspace.viewSourceMessage')}
										title={$t('documentWorkspace.viewSourceMessage')}
									>
								<ArrowUpRight size={13} strokeWidth={2.1} aria-hidden="true" />
									</button>
								{/if}
							</span>
							{#if getDocumentVersionLabel(document)}
								<span class="open-documents-rail-version">{getDocumentVersionLabel(document)}</span>
							{/if}
						</span>
						<span class="open-documents-rail-meta">
							<span class="open-documents-rail-source" class:open-documents-rail-source-ai={isAiGeneratedDocument(document)}>
								{#if isAiGeneratedDocument(document)}
								<Sparkles class="open-documents-rail-sparkle" size={12} strokeWidth={2.1} aria-hidden="true" />
								{/if}
								<span>{getDocumentSourceLabel(document)}</span>
							</span>
							{#if getDocumentDetailMetadata(document)}
								<span class="open-documents-rail-detail">{getDocumentDetailMetadata(document)}</span>
							{/if}
						</span>
						{#if document.documentFamilyStatus === "historical"}
							<span class="open-documents-rail-history">{$t('documentWorkspace.historical')}</span>
						{/if}
					</span>
				</div>
				<button
					type="button"
					class="open-documents-rail-close"
					onclick={() => onCloseDocument(document.id)}
					aria-label={$t('documentWorkspace.closeDocumentLabel', { title: getDocumentTitle(document) })}
				>
				<X size={13} strokeWidth={2.1} aria-hidden="true" />
				</button>
			</div>
		{/each}
	</nav>
{/if}

<style>
	.open-documents-rail {
		display: flex;
		flex: 0 0 clamp(13rem, 18vw, 17rem);
		flex-direction: column;
		gap: 0.42rem;
		width: clamp(13rem, 18vw, 17rem);
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 0.72rem 0.72rem 0.9rem;
		border-right: 1px solid var(--border-default);
		background: color-mix(in srgb, var(--surface-elevated) 48%, var(--surface-page) 52%);
		animation: rail-enter var(--duration-standard) ease-out;
	}

	.open-documents-rail-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.1rem 0.2rem 0.4rem;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.66rem;
		font-weight: 650;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.open-documents-rail-head span:last-child {
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
	}

	.open-documents-rail-row {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: start;
		gap: 0.18rem;
		border: 1px solid transparent;
		border-radius: 0.5rem;
		background: transparent;
		overflow: hidden;
		transition:
			border-color 180ms ease,
			background-color 180ms ease,
			box-shadow 180ms ease;
	}

	.open-documents-rail-row::before {
		content: "";
		position: absolute;
		inset: 0;
		background: color-mix(in srgb, var(--surface-page) 82%, var(--surface-elevated) 18%);
		opacity: 0;
		transform: scaleX(0.985);
		transform-origin: left center;
		transition:
			opacity 180ms ease,
			transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
		pointer-events: none;
	}

	.open-documents-rail-row-active {
		border-color: color-mix(in srgb, var(--text-primary) 14%, var(--border-default) 86%);
		background: color-mix(in srgb, var(--surface-page) 88%, var(--surface-elevated) 12%);
	}

	.open-documents-rail-row:not(.open-documents-rail-row-active):hover {
		border-color: color-mix(in srgb, var(--border-default) 84%, var(--text-primary) 16%);
	}

	.open-documents-rail-row:not(.open-documents-rail-row-active):hover::before {
		opacity: 1;
		transform: scaleX(1);
	}

	.open-documents-rail-tab {
		position: relative;
		z-index: 1;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: start;
		gap: 0.58rem;
		min-width: 0;
		padding: 0.58rem 0.28rem 0.58rem 0.62rem;
		border: none;
		background: transparent;
		text-align: left;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.open-documents-rail-row-active .open-documents-rail-tab {
		color: var(--text-primary);
	}

	.open-documents-rail-tab:focus-visible {
		outline: none;
	}

	.open-documents-rail-icon {
		display: inline-flex;
		margin-top: 0.08rem;
		color: var(--icon-muted);
		transition:
			color 180ms ease,
			transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.open-documents-rail-row:not(.open-documents-rail-row-active):hover .open-documents-rail-icon {
		color: var(--text-secondary);
		transform: translateY(-1px);
	}

	.open-documents-rail-text {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.18rem;
	}

	.open-documents-rail-title-row {
		display: flex;
		align-items: flex-start;
		gap: 0.38rem;
		min-width: 0;
	}

	.open-documents-rail-title-source {
		display: inline-flex;
		align-items: flex-start;
		gap: 0.2rem;
		min-width: 0;
		flex: 1 1 auto;
	}

	.open-documents-rail-title {
		display: -webkit-box;
		min-width: 0;
		flex: 1 1 auto;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-size: 0.82rem;
		line-height: 1.25;
	}

	.open-documents-rail-source-jump {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 1.05rem;
		height: 1.05rem;
		margin-top: 0.02rem;
		border: none;
		border-radius: 0.25rem;
		background: transparent;
		color: var(--icon-muted);
		opacity: 0.46;
		transform: translate(-1px, 1px) scale(0.96);
		transition:
			color 180ms ease,
			opacity 180ms ease,
			transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
			background-color 180ms ease;
	}

	.open-documents-rail-row:hover .open-documents-rail-source-jump,
	.open-documents-rail-source-jump:focus-visible {
		color: var(--text-primary);
		opacity: 1;
		transform: translate(1px, -1px) scale(1);
	}

	.open-documents-rail-source-jump:hover {
		background: color-mix(in srgb, var(--surface-page) 72%, transparent 28%);
	}

	.open-documents-rail-source-jump:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 68%, transparent 32%);
		outline-offset: 0.12rem;
	}

	.open-documents-rail-version,
	.open-documents-rail-history {
		display: inline-flex;
		align-items: center;
		flex: 0 0 auto;
		border: 1px solid var(--border-default);
		border-radius: 0.35rem;
		padding: 0.08rem 0.28rem;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.61rem;
		font-weight: 650;
		line-height: 1.15;
		color: var(--text-muted);
		background: var(--surface-page);
	}

	.open-documents-rail-history {
		align-self: flex-start;
		border-color: transparent;
		background: color-mix(in srgb, var(--surface-page) 74%, transparent 26%);
	}

	.open-documents-rail-meta {
		display: flex;
		align-items: center;
		gap: 0.32rem;
		min-width: 0;
		font-size: 0.68rem;
		color: var(--text-muted);
	}

	.open-documents-rail-source {
		display: inline-flex;
		align-items: center;
		gap: 0.16rem;
		min-width: 0;
		flex: 0 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.open-documents-rail-source-ai {
		flex: 0 0 auto;
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, var(--text-primary) 22%);
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-page) 74%, var(--surface-elevated) 26%);
		padding: 0.08rem 0.32rem;
		font-weight: 650;
		color: var(--text-secondary);
	}

	.open-documents-rail-sparkle {
		flex: 0 0 auto;
		color: var(--text-primary);
	}

	.open-documents-rail-detail {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.open-documents-rail-close {
		position: relative;
		z-index: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.65rem;
		height: 1.65rem;
		margin-top: 0.38rem;
		margin-right: 0.25rem;
		border: none;
		border-radius: 0.35rem;
		background: transparent;
		color: var(--icon-muted);
		opacity: 0.56;
		transition:
			opacity 180ms ease,
			background-color 180ms ease,
			color 180ms ease,
			transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.open-documents-rail-row:not(.open-documents-rail-row-active):hover .open-documents-rail-close,
	.open-documents-rail-row-active .open-documents-rail-close,
	.open-documents-rail-close:focus-visible {
		opacity: 1;
	}

	.open-documents-rail-close:hover {
		background: color-mix(in srgb, var(--surface-page) 82%, transparent 18%);
		color: var(--text-primary);
		transform: translateY(-1px);
	}

	@keyframes rail-enter {
		from {
			opacity: 0;
			transform: translateX(0.5rem);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.open-documents-rail {
			animation: none;
		}
	}
</style>
