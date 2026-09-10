<script lang="ts">
import { Check, TriangleAlert, Trash2, UserPlus, Users } from "@lucide/svelte";
import { fade } from "svelte/transition";
import { t } from "$lib/i18n";
import type { AdminManagedUserSummary } from "$lib/server/services/user-admin";
import { reducedMotionAware } from "$lib/utils/motion";
import {
	describeLastActive,
	formatCompactNumber,
	formatCount,
	tokenSplit,
	userInitials,
	userLabel,
} from "./users-table";

const toastFade = reducedMotionAware(fade);

let {
	user,
	currentUserId,
	modelNames,
	actionUserId = null,
	message = "",
	error = "",
	hiddenByFilter = false,
	onPromote,
	onDemote,
	onRevokeSessions,
	onDelete,
}: {
	user: AdminManagedUserSummary | null;
	currentUserId: string;
	modelNames: Record<string, string>;
	actionUserId?: string | null;
	message?: string;
	error?: string;
	hiddenByFilter?: boolean;
	onPromote: (userId: string) => void;
	onDemote: (userId: string) => void;
	onRevokeSessions: (userId: string) => void;
	onDelete: (userId: string) => void;
} = $props();

const TOAST_TIMEOUT_MS = 8000;

let toastVisible = $state(false);

// Results belong next to the button that produced them, and they clear
// themselves — the old screen printed them in the left rail and kept them
// forever.
$effect(() => {
	const hasToast = Boolean(message || error);
	toastVisible = hasToast;
	if (!hasToast) return;
	const timer = setTimeout(() => {
		toastVisible = false;
	}, TOAST_TIMEOUT_MS);
	return () => clearTimeout(timer);
});

let isSelf = $derived(Boolean(user && user.id === currentUserId));
let busy = $derived(Boolean(user && actionUserId === user.id));
let split = $derived(
	user ? tokenSplit(user.completionTokens, user.reasoningTokens) : null,
);

function modelDisplayName(model: string | null | undefined): string {
	if (!model) return "—";
	return modelNames[model] ?? model;
}

function formatDate(timestamp: number | null | undefined): string {
	if (timestamp == null || !Number.isFinite(timestamp)) return "—";
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
		new Date(timestamp),
	);
}

function formatDateTime(timestamp: number | null | undefined): string {
	if (timestamp == null || !Number.isFinite(timestamp)) {
		return $t("admin.users.lastActive.never");
	}
	const descriptor = describeLastActive(timestamp);
	if (descriptor.kind === "now") return $t("admin.users.lastActive.now");
	if (descriptor.kind === "minutes") {
		return $t("admin.users.lastActive.minutes", { count: descriptor.value });
	}
	if (descriptor.kind === "hours") {
		return $t("admin.users.lastActive.hours", { count: descriptor.value });
	}
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(timestamp));
}
</script>

<div class="detail-panel" data-testid="admin-user-detail">
	{#if user}
		<div class="detail-head">
			<span class="avatar-lg" aria-hidden="true">{userInitials(user)}</span>
			<div class="min-w-0 flex-1">
				<h3 class="detail-name">{userLabel(user)}</h3>
				<p class="detail-email">{user.email}</p>
			</div>
			<span class="pill" class:pill-accent={user.role === 'admin'} class:pill-outline={user.role !== 'admin'}>
				{user.role === 'admin' ? $t('admin.admin') : $t('admin.user')}
			</span>
		</div>

		{#if hiddenByFilter}
			<p class="hidden-note">{$t('admin.users.hiddenByFilter')}</p>
		{/if}

		{#if toastVisible && (message || error)}
			<div
				class="toast"
				class:toast-error={Boolean(error)}
				role={error ? 'alert' : 'status'}
				transition:toastFade={{ duration: 150 }}
			>
				<span class="toast-icon">
					{#if error}
						<TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
					{:else}
						<Check size={14} strokeWidth={2} aria-hidden="true" />
					{/if}
				</span>
				<span>{error || message}</span>
			</div>
		{/if}

		<div class="stat-card--hero mt-4">
			<div class="stat-value-hero">{formatCompactNumber(user.totalTokenCount)}</div>
			<div class="stat-label">{$t('admin.users.tokensAllTime')}</div>
			<div class="stat-comparison">
				{$t('admin.users.tokenSplit', {
					completion: formatCompactNumber(user.completionTokens),
					reasoning: formatCompactNumber(user.reasoningTokens),
				})}
			</div>
			{#if split}
				<div class="token-bar" aria-hidden="true">
					<span class="token-bar-completion" style={`flex: ${split.completion}`}></span>
					<span class="token-bar-reasoning" style={`flex: ${split.reasoning}`}></span>
				</div>
			{/if}
		</div>

		<div class="stat-grid">
			<div class="stat-card">
				<div class="stat-value">{formatCount(user.messageCount)}</div>
				<div class="stat-label">{$t('admin.messages')}</div>
			</div>
			<div class="stat-card">
				<div class="stat-value">{formatCount(user.conversationCount)}</div>
				<div class="stat-label">{$t('admin.conversations')}</div>
			</div>
		</div>

		<div class="rule"></div>

		<dl class="meta-list">
			<div class="meta-row">
				<dt>{$t('admin.favoriteModel')}</dt>
				<dd class="meta-strong">{modelDisplayName(user.favoriteModel)}</dd>
			</div>
			<div class="meta-row">
				<dt>{$t('admin.joined')}</dt>
				<dd>{formatDate(user.createdAt)}</dd>
			</div>
			<div class="meta-row">
				<dt>{$t('admin.lastActive')}</dt>
				<dd data-testid="admin-user-last-active">{formatDateTime(user.lastActiveAt)}</dd>
			</div>
			<div class="meta-row">
				<dt>{$t('admin.activeSessions')}</dt>
				<dd class="sessions-cell">
					<span>{formatCount(user.activeSessionCount)}</span>
					<button
						type="button"
						class="mini-btn"
						disabled={busy || isSelf}
						onclick={() => onRevokeSessions(user.id)}
					>
						{busy ? $t('admin.working') : $t('admin.revokeSessions')}
					</button>
				</dd>
			</div>
		</dl>

		<div class="rule"></div>

		<p class="eyebrow">{$t('admin.users.actions')}</p>
		<div class="action-stack">
			{#if user.role === 'admin'}
				<button
					type="button"
					class="btn-secondary w-full justify-center gap-1.5"
					disabled={busy || isSelf}
					onclick={() => onDemote(user.id)}
				>
					<Users size={14} strokeWidth={2} aria-hidden="true" />
					{busy ? $t('common.saving') : $t('admin.demoteToUser')}
				</button>
			{:else}
				<button
					type="button"
					class="btn-secondary w-full justify-center gap-1.5"
					disabled={busy || isSelf}
					onclick={() => onPromote(user.id)}
				>
					<UserPlus size={14} strokeWidth={2} aria-hidden="true" />
					{busy ? $t('common.saving') : $t('admin.promoteToAdmin')}
				</button>
			{/if}
			<button
				type="button"
				class="btn-danger w-full justify-center gap-1.5"
				disabled={busy || isSelf}
				onclick={() => onDelete(user.id)}
			>
				<Trash2 size={14} strokeWidth={2} aria-hidden="true" />
				{$t('admin.deleteUser')}
			</button>
			{#if isSelf}
				<p class="action-note">{$t('admin.profileTabNote')}</p>
			{:else}
				<p class="action-note">
					{$t('admin.users.actionNote', { name: userLabel(user) })}
				</p>
			{/if}
		</div>
	{:else}
		<div class="empty">{$t('admin.selectUser')}</div>
	{/if}
</div>

<style>
	.detail-panel {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-overlay);
		padding: 1.125rem 1.25rem;
	}

	.detail-head {
		display: flex;
		align-items: flex-start;
		gap: 0.7rem;
	}

	.avatar-lg {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-size: 0.78rem;
		font-weight: 700;
	}

	.detail-name {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	.detail-email {
		margin-top: 2px;
		font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: var(--text-2xs);
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.hidden-note {
		margin-top: 0.75rem;
		font-size: var(--text-2xs);
		color: var(--text-muted);
		line-height: 1.5;
	}

	.toast {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 0.875rem;
		padding: 0.55rem 0.75rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		box-shadow: var(--shadow-lg);
		font-size: var(--text-xs);
		line-height: 1.5;
		color: var(--text-primary);
	}

	.toast-icon {
		flex-shrink: 0;
		margin-top: 1px;
		color: var(--success);
		display: inline-flex;
	}

	.toast-error .toast-icon {
		color: var(--danger);
	}

	.token-bar {
		display: flex;
		height: 5px;
		border-radius: 3px;
		overflow: hidden;
		margin-top: 0.45rem;
		background: var(--surface-elevated);
	}

	.token-bar-completion {
		background: var(--accent);
	}

	.token-bar-reasoning {
		background: color-mix(in srgb, var(--accent) 40%, transparent);
	}

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.625rem;
		margin-top: 0.625rem;
	}

	.rule {
		height: 1px;
		background: var(--border-subtle);
		margin: 0.875rem 0;
	}

	.meta-list {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.meta-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		font-size: var(--text-2xs);
	}

	.meta-row dt {
		flex: 1 1 auto;
		min-width: 0;
		color: var(--text-muted);
	}

	.meta-row dd {
		color: var(--text-primary);
		text-align: right;
	}

	.meta-strong {
		font-weight: 500;
	}

	.sessions-cell {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	.mini-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		height: 26px;
		padding: 0 0.5rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		color: var(--text-secondary);
		font-size: var(--text-2xs);
		white-space: nowrap;
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			background var(--duration-standard) var(--ease-out);
	}

	.mini-btn:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--accent);
	}

	.mini-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.mini-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.eyebrow {
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
		margin-bottom: 0.5rem;
	}

	.action-stack {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.action-note {
		font-size: var(--text-2xs);
		line-height: 1.5;
		color: var(--text-muted);
	}

	.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px dashed var(--border-default);
		border-radius: var(--radius-md);
		padding: 2.5rem 1rem;
		font-size: var(--text-md);
		color: var(--text-muted);
		text-align: center;
	}

	.pill {
		display: inline-flex;
		align-items: center;
		padding: 1px 8px;
		border-radius: var(--radius-full);
		font-size: 0.7rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.pill-accent {
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}

	.pill-outline {
		color: var(--text-muted);
		background: var(--surface-page);
		border: 1px solid var(--border-default);
		font-weight: 500;
	}
</style>
