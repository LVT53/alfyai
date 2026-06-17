<script lang="ts">
import { onMount } from "svelte";
import { t } from "$lib/i18n";
import type { LinkedContextSource } from "$lib/types";

let {
	sources,
	onClose,
	onRemove,
	onClear,
	onAddDocument,
}: {
	sources: LinkedContextSource[];
	onClose: () => void;
	onRemove: (displayArtifactId: string) => void;
	onClear: () => void;
	onAddDocument: () => void;
} = $props();

let panel = $state<HTMLElement | null>(null);

function sourceTypeLabel(source: LinkedContextSource): string {
	if (!source.documentOrigin) {
		return $t("linkedSources.type.uploaded");
	}
	return source.documentOrigin === "generated"
		? $t("linkedSources.type.generated")
		: $t("linkedSources.type.uploaded");
}

const visibleSources = $derived(
	sources.filter((source) => source.documentOrigin != null),
);

function handlePointerDown(event: PointerEvent) {
	if (!panel) return;
	const target = event.target;
	if (target instanceof Node && panel.contains(target)) return;
	onClose();
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		onClose();
	}
}

onMount(() => {
	setTimeout(() => panel?.focus(), 0);
});
</script>

<svelte:document onpointerdown={handlePointerDown} onkeydown={handleKeydown} />

<div
	bind:this={panel}
	class="source-manager"
	role="dialog"
	aria-label={$t("sourceManager.title")}
	tabindex="-1"
>
	<header class="source-manager__header">
		<div>
			<h2>{$t("sourceManager.title")}</h2>
			<p>{$t("sourceManager.description", { count: visibleSources.length })}</p>
		</div>
		<button
			type="button"
			class="source-manager__icon-button"
			aria-label={$t("sourceManager.close")}
			onclick={onClose}
		>
			<span aria-hidden="true">x</span>
		</button>
	</header>

	{#if visibleSources.length > 0}
		<ul class="source-manager__list" aria-label={$t("sourceManager.list")}>
			{#each visibleSources as source (source.displayArtifactId)}
				<li class="source-manager__row">
					<div class="source-manager__copy">
						<span class="source-manager__title">{source.name}</span>
						<span class="source-manager__meta">{sourceTypeLabel(source)}</span>
					</div>
					<button
						type="button"
						class="source-manager__secondary"
						aria-label={$t("linkedSources.removeA11y", { name: source.name })}
						onclick={() => onRemove(source.displayArtifactId)}
					>
						{$t("linkedSources.remove")}
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="source-manager__empty">{$t("sourceManager.empty")}</p>
	{/if}

	<footer class="source-manager__footer">
		<button type="button" class="source-manager__secondary" onclick={onAddDocument}>
			{$t("sourceManager.addDocument")}
		</button>
		<button
			type="button"
			class="source-manager__secondary"
			disabled={visibleSources.length === 0}
			onclick={onClear}
		>
			{$t("sourceManager.clearAll")}
		</button>
	</footer>
</div>

<style>
	.source-manager {
		position: absolute;
		left: 8px;
		right: 8px;
		bottom: calc(100% + 8px);
		z-index: 45;
		display: flex;
		flex-direction: column;
		gap: 10px;
		max-height: min(360px, calc(100vh - 160px));
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--border-default) 82%, var(--accent) 18%);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface-overlay) 94%, var(--surface-page) 6%);
		box-shadow:
			0 18px 42px rgb(15 23 42 / 0.2),
			0 1px 0 color-mix(in srgb, white 32%, transparent 68%) inset;
		padding: 12px;
		color: var(--text-primary);
		animation: sourceManagerIn 140ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.source-manager:focus {
		outline: none;
	}

	.source-manager__header,
	.source-manager__footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.source-manager__header h2 {
		margin: 0;
		font-size: var(--text-base);
		font-weight: 650;
		color: var(--text-primary);
	}

	.source-manager__header p,
	.source-manager__empty,
	.source-manager__meta {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.source-manager__icon-button,
	.source-manager__secondary {
		border: 1px solid color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-elevated) 72%, transparent 28%);
		color: var(--text-primary);
		font-size: var(--text-xs);
		font-weight: 600;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.source-manager__icon-button {
		width: 30px;
		height: 30px;
		display: inline-grid;
		place-items: center;
	}

	.source-manager__secondary {
		padding: 7px 10px;
	}

	.source-manager__secondary:disabled {
		cursor: not-allowed;
		color: var(--text-muted);
		opacity: 0.55;
	}

	.source-manager__icon-button:hover,
	.source-manager__icon-button:focus-visible,
	.source-manager__secondary:hover:not(:disabled),
	.source-manager__secondary:focus-visible:not(:disabled) {
		border-color: color-mix(in srgb, var(--accent) 42%, var(--border-default) 58%);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated) 88%);
		color: var(--accent);
		transform: translateY(-1px);
	}

	.source-manager__icon-button:focus-visible,
	.source-manager__secondary:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 36%, transparent 64%);
		outline: none;
	}

	.source-manager__icon-button:active,
	.source-manager__secondary:active:not(:disabled) {
		transform: translateY(0);
	}

	.source-manager__list {
		display: flex;
		min-height: 0;
		flex-direction: column;
		gap: 8px;
		overflow-y: auto;
		padding: 0;
		margin: 0;
		list-style: none;
	}

	.source-manager__row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		border: 1px solid color-mix(in srgb, var(--border-default) 72%, transparent 28%);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-page) 74%, var(--surface-elevated) 26%);
		padding: 8px;
	}

	.source-manager__copy {
		display: grid;
		min-width: 0;
		gap: 2px;
	}

	.source-manager__title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-sm);
		font-weight: 600;
	}

	.source-manager__empty {
		border: 1px dashed color-mix(in srgb, var(--border-default) 78%, var(--accent) 22%);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-page) 70%, transparent 30%);
		padding: 14px;
		text-align: center;
	}

	:global(.dark) .source-manager {
		background: color-mix(in srgb, var(--surface-overlay) 92%, var(--surface-page) 8%);
		box-shadow:
			0 20px 46px rgb(0 0 0 / 0.46),
			0 1px 0 color-mix(in srgb, white 8%, transparent 92%) inset;
	}

	:global(.dark) .source-manager__row {
		background: color-mix(in srgb, var(--surface-page) 60%, var(--surface-elevated) 40%);
	}

	@keyframes sourceManagerIn {
		from {
			opacity: 0;
			transform: translateY(0.4rem);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (max-width: 640px) {
		.source-manager {
			position: fixed;
			left: max(10px, env(safe-area-inset-left));
			right: max(10px, env(safe-area-inset-right));
			bottom: calc(6.75rem + env(safe-area-inset-bottom));
			max-height: min(360px, 46dvh);
			border-radius: 12px;
		}

		.source-manager__header {
			align-items: flex-start;
		}

		.source-manager__footer {
			flex-wrap: wrap;
			justify-content: flex-start;
		}

		.source-manager__secondary {
			min-height: 36px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.source-manager,
		.source-manager__icon-button,
		.source-manager__secondary {
			animation: none;
			transition: none;
		}
	}
</style>
