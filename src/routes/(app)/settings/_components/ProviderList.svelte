<script lang="ts">
import { untrack } from "svelte";
import { get } from "svelte/store";
import { t } from "$lib/i18n";
import { ChevronDown, ChevronUp, Pencil, Trash2 } from "@lucide/svelte";
import type { Provider } from "$lib/client/api/admin";

const tVal = get(t);

let {
	providers = [],
	loading = false,
	error = "",
	message = "",
	onAdd,
	onEdit,
	onDelete,
	onToggleEnabled,
	onDiscover,
	onManageModels,
	onReorder,
}: {
	providers: Provider[];
	loading?: boolean;
	error?: string;
	message?: string;
	onAdd: () => void;
	onEdit: (provider: Provider) => void;
	onDelete: (provider: Provider) => void;
	onToggleEnabled: (
		provider: Provider,
		enabled: boolean,
	) => void | Promise<void>;
	onDiscover: (provider: Provider) => void | Promise<void>;
	onManageModels?: (providerId: string) => void;
	onReorder?: (
		providerId: string,
		direction: "up" | "down",
	) => void | Promise<void>;
} = $props();

let deletingId = $state<string | null>(null);
let togglingId = $state<string | null>(null);
let discoveringId = $state<string | null>(null);
let movingId = $state<string | null>(null);

function truncateUrl(url: string, max = 48): string {
	return url.length > max ? `${url.slice(0, max)}…` : url;
}

async function handleMove(provider: Provider, direction: "up" | "down") {
	movingId = provider.id;
	try {
		await onReorder?.(provider.id, direction);
	} finally {
		movingId = null;
	}
}

async function handleToggle(provider: Provider) {
	togglingId = provider.id;
	try {
		await onToggleEnabled(provider, !provider.enabled);
	} finally {
		togglingId = null;
	}
}

async function handleDiscover(provider: Provider) {
	discoveringId = provider.id;
	try {
		await onDiscover(provider);
	} finally {
		discoveringId = null;
	}
}

async function handleDelete(provider: Provider) {
	if (
		!confirm($t("admin.deleteProviderConfirm", { name: provider.displayName }))
	)
		return;
	deletingId = provider.id;
	try {
		await onDelete(provider);
	} finally {
		deletingId = null;
	}
}
</script>

<div class="flex flex-col gap-3">
	<div class="flex items-center justify-between">
		<h3 class="text-sm font-medium text-text-primary">{$t('admin.providers')}</h3>
		<button class="btn-small" onclick={onAdd}>{$t('admin.addProvider')}</button>
	</div>

	{#if loading}
		<p class="text-sm text-text-secondary">{$t('common.loading')}</p>
	{:else if error}
		<p class="text-sm text-danger">{error}</p>
	{:else if providers.length === 0}
		<div class="rounded-md border border-border bg-surface-page px-4 py-6 text-center">
			<p class="text-sm text-text-muted">{$t('admin.noProvidersYet')}</p>
			<button class="btn-secondary mt-3" onclick={onAdd}>{$t('admin.addProvider')}</button>
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each providers as provider (provider.id)}
				<div
					class="flex flex-col gap-2 rounded-md border border-border bg-surface-page px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
				>
					<div class="flex min-w-0 items-center gap-3">
						<span
							class="inline-block h-2 w-2 shrink-0 rounded-full"
							class:bg-success={provider.enabled}
							class:bg-text-muted={!provider.enabled}
						></span>
						<div class="flex min-w-0 flex-col">
							<span class="truncate text-sm font-medium text-text-primary">
								{provider.displayName}
							</span>
							<span class="truncate text-xs text-text-muted">
								{provider.name} &bull; {truncateUrl(provider.baseUrl)}
							</span>
						</div>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<label class="relative inline-flex cursor-pointer items-center">
							<input
								type="checkbox"
								class="peer sr-only"
								checked={provider.enabled}
								disabled={togglingId === provider.id}
								onchange={() => handleToggle(provider)}
							/>
							<div
								class="peer h-5 w-9 rounded-full bg-surface-secondary after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full"
							></div>
						</label>
						<button
							class="btn-small whitespace-nowrap"
							disabled={discoveringId === provider.id}
							onclick={() => handleDiscover(provider)}
						>
							{discoveringId === provider.id ? $t('common.loading') : $t('admin.discoverModels')}
						</button>
						{#if onManageModels}
							<button
								class="btn-small whitespace-nowrap"
								onclick={() => onManageModels(provider.id)}
							>
								{$t('admin.manageModels')}
							</button>
						{/if}
						{#if onReorder}
							<button
								class="btn-small whitespace-nowrap"
								disabled={movingId === provider.id || providers.indexOf(provider) === 0}
								onclick={() => handleMove(provider, "up")}
								title="Move up"
							>
								<ChevronUp class="h-4 w-4" size={16} strokeWidth={2} aria-hidden="true" />
							</button>
							<button
								class="btn-small whitespace-nowrap"
								disabled={movingId === provider.id || providers.indexOf(provider) === providers.length - 1}
								onclick={() => handleMove(provider, "down")}
								title="Move down"
							>
								<ChevronDown class="h-4 w-4" size={16} strokeWidth={2} aria-hidden="true" />
							</button>
						{/if}
						<button class="btn-small whitespace-nowrap" onclick={() => onEdit(provider)} title="Edit">
							<Pencil class="h-4 w-4" size={16} strokeWidth={2} aria-hidden="true" />
						</button>
						<button
							class="btn-small whitespace-nowrap text-danger"
							disabled={deletingId === provider.id}
							onclick={() => handleDelete(provider)}
							title="Delete"
						>
							{#if deletingId === provider.id}
								…
							{:else}
								<Trash2 class="h-4 w-4" size={16} strokeWidth={2} aria-hidden="true" />
							{/if}
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if message}
		<p class="text-sm text-success">{message}</p>
	{/if}
</div>
