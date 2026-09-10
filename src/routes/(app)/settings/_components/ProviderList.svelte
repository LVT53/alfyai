<script lang="ts">
// The provider list, rebuilt to the board: one row per provider with three
// controls instead of nine — models, on/off, and a menu holding Discover,
// Manage, Edit, Test and Delete — and the models themselves in a drawer on the
// row rather than a raw `fixed inset-0` overlay.
import {
	AlertTriangle,
	Bolt,
	ChevronDown,
	ChevronUp,
	MoreVertical,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	SlidersHorizontal,
	TestTube,
	Trash2,
} from "@lucide/svelte";
import { slide } from "svelte/transition";
import type { Provider, ProviderModel } from "$lib/client/api/admin";
import { t } from "$lib/i18n";
import {
	regionCodeToFlag,
	regionDisplayName,
} from "$lib/services/processing-region";
import { reducedMotionAware } from "$lib/utils/motion";
import { providerHasFallbackWarning } from "./model-fallback";
import "./system/system.css";

const drawerSlide = reducedMotionAware(slide);

let {
	providers = [],
	providerModels = [],
	loading = false,
	error = "",
	message = "",
	openProviderId = $bindable(""),
	busyProviderId = "",
	onAdd,
	onEdit,
	onDelete,
	onToggleEnabled,
	onDiscover,
	onManageModels,
	onReorder,
	onTest,
	drawer,
}: {
	providers: Provider[];
	providerModels?: ProviderModel[];
	loading?: boolean;
	error?: string;
	message?: string;
	/** Provider whose model drawer is open. */
	openProviderId?: string;
	/** Provider currently being deleted — its row's controls go inert. */
	busyProviderId?: string;
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
	onTest?: (provider: Provider) => void | Promise<void>;
	/** Rendered inside the open provider's drawer. */
	drawer?: import("svelte").Snippet<[string]>;
} = $props();

let togglingId = $state<string | null>(null);
let discoveringId = $state<string | null>(null);
let movingId = $state<string | null>(null);
let menuProviderId = $state<string | null>(null);
let enabledOnly = $state(false);

const shown = $derived(
	enabledOnly ? providers.filter((provider) => provider.enabled) : providers,
);

function truncateUrl(url: string, max = 48): string {
	return url.length > max ? `${url.slice(0, max)}…` : url;
}

function initials(provider: Provider): string {
	return provider.displayName.slice(0, 2).toUpperCase();
}

function modelCount(providerId: string): number {
	return providerModels.filter((model) => model.providerId === providerId)
		.length;
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
	menuProviderId = null;
	discoveringId = provider.id;
	try {
		await onDiscover(provider);
	} finally {
		discoveringId = null;
	}
}

function toggleDrawer(provider: Provider) {
	openProviderId = openProviderId === provider.id ? "" : provider.id;
	if (openProviderId) onManageModels?.(provider.id);
}

function closeMenu() {
	menuProviderId = null;
}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape') closeMenu();
	}}
/>

<div class="sys-stack" data-testid="provider-list">
	<div class="sys-card-head" style="margin-bottom: 0">
		<span class="sys-grow">
			<h3 class="sys-card-title">{$t('admin.system.providers.title')}</h3>
			<p class="sys-card-desc">{$t('admin.system.providers.description')}</p>
		</span>
		<span class="sys-card-actions">
			<button
				type="button"
				class="sys-mini"
				class:sys-mini-on={enabledOnly}
				aria-pressed={enabledOnly}
				onclick={() => (enabledOnly = !enabledOnly)}
			>
				<SlidersHorizontal size={12} strokeWidth={2} aria-hidden="true" />
				{$t('admin.system.providers.enabledOnly')}
			</button>
			<button type="button" class="btn-primary btn-sm" onclick={onAdd}>
				<Plus size={13} strokeWidth={2} aria-hidden="true" />
				{$t('admin.system.providers.add')}
			</button>
		</span>
	</div>

	{#if loading}
		<p class="sys-sm sys-muted">{$t('common.loading')}</p>
	{:else if error}
		<p class="sys-error" role="alert">{error}</p>
	{:else if providers.length === 0}
		<div class="sys-empty">
			<p style="margin: 0 0 10px">{$t('admin.noProvidersYet')}</p>
			<button type="button" class="btn-secondary btn-sm" onclick={onAdd}>
				{$t('admin.system.providers.add')}
			</button>
		</div>
	{:else if shown.length === 0}
		<div class="sys-empty">{$t('admin.system.providers.emptyFiltered')}</div>
	{:else}
		<div class="sys-list">
			{#each shown as provider, index (provider.id)}
				{@const count = modelCount(provider.id)}
				{@const open = openProviderId === provider.id}
				<div>
					<div
						class="sys-list-row"
						class:sys-row-busy={busyProviderId === provider.id}
						style={open ? 'border-radius: var(--radius-md) var(--radius-md) 0 0' : ''}
						data-testid={`provider-row-${provider.id}`}
						aria-busy={busyProviderId === provider.id}
					>
						<span
							class="sys-dot"
							class:sys-dot-on={provider.enabled}
							class:sys-dot-off={!provider.enabled}
						></span>
						<span class="sys-avatar" aria-hidden="true">
							{#if provider.iconAssetId}
								<img
									src={`/api/campaign-assets/${encodeURIComponent(provider.iconAssetId)}/content`}
									alt=""
								/>
							{:else}
								{initials(provider)}
							{/if}
						</span>

						<span class="sys-grow" style="min-width: 0">
							<span class="sys-label">
								<span class="sys-truncate">{provider.displayName}</span>
								{#if provider.processingRegionCode}
									<span
										class="sys-pill sys-pill-outline"
										title={$t('modelSelector.processingRegion', {
											region: regionDisplayName(provider.processingRegionCode),
										})}
									>
										{regionCodeToFlag(provider.processingRegionCode)}
										{provider.processingRegionCode.toUpperCase()}
									</span>
								{/if}
								{#if providerHasFallbackWarning(provider.id, providerModels)}
									<span
										class="sys-nowrap"
										style="color: var(--danger); display: inline-flex"
										title={$t('admin.modelFallbackProviderWarning')}
										aria-label={$t('admin.modelFallbackProviderWarning')}
										role="img"
									>
										<AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
									</span>
								{/if}
							</span>
							<span class="sys-key">
								{provider.name} · {truncateUrl(provider.baseUrl)}
							</span>
						</span>

						<button
							type="button"
							class="sys-mini"
							aria-expanded={open}
							aria-label={$t('admin.system.providers.expandA11y', {
								provider: provider.displayName,
							})}
							data-testid={`provider-models-${provider.id}`}
							onclick={() => toggleDrawer(provider)}
						>
							{count === 1
								? $t('admin.system.providers.modelCountOne')
								: $t('admin.system.providers.modelCount', { count: String(count) })}
							{#if open}
								<ChevronUp size={12} strokeWidth={2} aria-hidden="true" />
							{:else}
								<ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
							{/if}
						</button>

						<button
							type="button"
							role="switch"
							class="sys-toggle"
							aria-checked={provider.enabled}
							aria-label={$t('admin.system.providers.toggleA11y', {
								provider: provider.displayName,
							})}
							disabled={togglingId === provider.id || busyProviderId === provider.id}
							data-testid={`provider-toggle-${provider.id}`}
							onclick={() => handleToggle(provider)}
						>
							<span class="sys-toggle-thumb"></span>
						</button>
						<span
							class="sys-chip sys-chip-live"
							title={$t('admin.system.appliesImmediately')}
							aria-label={$t('admin.system.appliesImmediately')}
							role="img"
						>
							<Bolt size={10} strokeWidth={2.5} aria-hidden="true" />
						</span>

						{#if onReorder}
							<button
								type="button"
								class="sys-mini"
								disabled={movingId === provider.id || index === 0}
								aria-label={$t('admin.system.providers.moveUp', {
									provider: provider.displayName,
								})}
								onclick={() => handleMove(provider, 'up')}
							>
								<ChevronUp size={13} strokeWidth={2} aria-hidden="true" />
							</button>
							<button
								type="button"
								class="sys-mini"
								disabled={movingId === provider.id || index === shown.length - 1}
								aria-label={$t('admin.system.providers.moveDown', {
									provider: provider.displayName,
								})}
								onclick={() => handleMove(provider, 'down')}
							>
								<ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
							</button>
						{/if}

						<span style="position: relative">
							<button
								type="button"
								class="sys-mini"
								aria-haspopup="menu"
								aria-expanded={menuProviderId === provider.id}
								aria-label={$t('admin.system.providers.menu', {
									provider: provider.displayName,
								})}
								disabled={busyProviderId === provider.id}
								data-testid={`provider-menu-${provider.id}`}
								onclick={() =>
									(menuProviderId = menuProviderId === provider.id ? null : provider.id)}
							>
								<MoreVertical size={14} strokeWidth={2} aria-hidden="true" />
							</button>
							{#if menuProviderId === provider.id}
								<div
									class="sys-menu"
									role="menu"
									transition:drawerSlide={{ duration: 140 }}
								>
									<button
										type="button"
										role="menuitem"
										class="sys-menu-item"
										disabled={discoveringId === provider.id}
										onclick={() => handleDiscover(provider)}
									>
										<Search size={14} strokeWidth={2} aria-hidden="true" />
										{discoveringId === provider.id
											? $t('common.loading')
											: $t('admin.system.providers.discover')}
									</button>
									<button
										type="button"
										role="menuitem"
										class="sys-menu-item"
										onclick={() => {
											closeMenu();
											openProviderId = provider.id;
											onManageModels?.(provider.id);
										}}
									>
										<SlidersHorizontal size={14} strokeWidth={2} aria-hidden="true" />
										{$t('admin.system.providers.manage')}
									</button>
									<button
										type="button"
										role="menuitem"
										class="sys-menu-item"
										onclick={() => {
											closeMenu();
											onEdit(provider);
										}}
									>
										<Pencil size={14} strokeWidth={2} aria-hidden="true" />
										{$t('admin.system.providers.edit')}
									</button>
									{#if onTest}
										<button
											type="button"
											role="menuitem"
											class="sys-menu-item"
											onclick={() => {
												closeMenu();
												void onTest?.(provider);
											}}
										>
											<TestTube size={14} strokeWidth={2} aria-hidden="true" />
											{$t('admin.system.providers.test')}
										</button>
									{/if}
									<span class="sys-menu-sep"></span>
									<button
										type="button"
										role="menuitem"
										class="sys-menu-item sys-menu-item-danger"
										data-testid={`provider-delete-${provider.id}`}
										onclick={() => {
											closeMenu();
											onDelete(provider);
										}}
									>
										<Trash2 size={14} strokeWidth={2} aria-hidden="true" />
										{$t('admin.system.providers.delete')}
									</button>
								</div>
							{/if}
						</span>
					</div>

					{#if open}
						<div class="sys-list-drawer" transition:drawerSlide={{ duration: 180 }}>
							<div class="sys-list-drawer-head">
								<span class="sys-eyebrow sys-grow">
									{$t('admin.system.providers.modelsOn', {
										provider: provider.displayName,
									})}
								</span>
								<button
									type="button"
									class="sys-mini"
									disabled={discoveringId === provider.id}
									onclick={() => handleDiscover(provider)}
								>
									<RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
									{$t('admin.system.providers.discover')}
								</button>
							</div>
							<div style="padding: 10px 12px">
								{#if drawer}
									{@render drawer(provider.id)}
								{/if}
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if message}
		<p class="sys-sm" style="color: var(--success)" role="status">{message}</p>
	{/if}
</div>
