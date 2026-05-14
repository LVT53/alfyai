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
		return source.documentOrigin === "generated"
			? $t("linkedSources.type.generated")
			: $t("linkedSources.type.uploaded");
	}

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
			<p>{$t("sourceManager.description", { count: sources.length })}</p>
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

	{#if sources.length > 0}
		<ul class="source-manager__list" aria-label={$t("sourceManager.list")}>
			{#each sources as source (source.displayArtifactId)}
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
			disabled={sources.length === 0}
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
		border: 1px solid var(--color-border, #d8dee8);
		border-radius: 12px;
		background: var(--color-surface-elevated, #fff);
		box-shadow: 0 18px 42px rgb(15 23 42 / 0.18);
		padding: 12px;
		color: var(--color-text-primary, #101828);
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
		font-size: 14px;
		font-weight: 650;
	}

	.source-manager__header p,
	.source-manager__empty,
	.source-manager__meta {
		margin: 0;
		color: var(--color-text-muted, #667085);
		font-size: 12px;
	}

	.source-manager__icon-button,
	.source-manager__secondary {
		border: 1px solid var(--color-border, #d8dee8);
		border-radius: 8px;
		background: transparent;
		color: var(--color-text-primary, #101828);
		font-size: 12px;
		font-weight: 600;
	}

	.source-manager__icon-button {
		width: 30px;
		height: 30px;
	}

	.source-manager__secondary {
		padding: 7px 10px;
	}

	.source-manager__secondary:disabled {
		cursor: not-allowed;
		color: var(--color-text-muted, #667085);
		opacity: 0.55;
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
		border: 1px solid var(--color-border-subtle, #e6e9ef);
		border-radius: 8px;
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
		font-size: 13px;
		font-weight: 600;
	}

	.source-manager__empty {
		border: 1px dashed var(--color-border, #d8dee8);
		border-radius: 8px;
		padding: 14px;
		text-align: center;
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
</style>
