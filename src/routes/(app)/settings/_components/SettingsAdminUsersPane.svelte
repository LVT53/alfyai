<script lang="ts">
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import { t } from "$lib/i18n";
import type { AdminManagedUserSummary } from "$lib/types";

type RoleFilter = "all" | "user" | "admin";
type SortKey = "recent" | "messages" | "conversations" | "tokens";

let {
	users = [],
	usersLoading = false,
	usersError = "",
	usersMessage = "",
	currentUserId,
	modelNames,
	selectedUserId = $bindable(null),
	actionUserId = null,
	onReload,
	onOpenCreateUser,
	onPromoteUser,
	onDemoteUser,
	onDeleteUser,
	onRevokeSessions,
}: {
	users?: AdminManagedUserSummary[];
	usersLoading?: boolean;
	usersError?: string;
	usersMessage?: string;
	currentUserId: string;
	modelNames: Record<string, string>;
	selectedUserId: string | null;
	actionUserId?: string | null;
	onReload: () => void | Promise<void>;
	onOpenCreateUser: () => void;
	onPromoteUser: (userId: string) => void | Promise<void>;
	onDemoteUser: (userId: string) => void | Promise<void>;
	onDeleteUser: (userId: string) => void | Promise<void>;
	onRevokeSessions: (userId: string) => void | Promise<void>;
} = $props();

let search = $state("");
let roleFilter = $state<RoleFilter>("all");
let sortKey = $state<SortKey>("recent");
let deleteCandidateId = $state<string | null>(null);

function userLabel(user: AdminManagedUserSummary): string {
	return user.name?.trim() || user.email;
}

function modelDisplayName(model: string | null): string {
	if (!model) return "—";
	return modelNames[model] ?? model;
}

function formatCount(value: number): string {
	return value.toLocaleString();
}

function formatDate(timestamp: number | null | undefined): string {
	if (timestamp == null || !isFinite(timestamp)) {
		return "—";
	}
	return new Date(timestamp).toLocaleString();
}

function matchesSearch(user: AdminManagedUserSummary, query: string): boolean {
	if (!query) return true;
	const haystack = `${user.name ?? ""} ${user.email}`.toLowerCase();
	return haystack.includes(query.toLowerCase());
}

let filteredUsers = $derived(
	[...users]
		.filter((user) => (roleFilter === "all" ? true : user.role === roleFilter))
		.filter((user) => matchesSearch(user, search.trim()))
		.sort((left, right) => {
			if (sortKey === "messages") return right.messageCount - left.messageCount;
			if (sortKey === "conversations")
				return right.conversationCount - left.conversationCount;
			if (sortKey === "tokens")
				return right.totalTokenCount - left.totalTokenCount;
			const leftRecent = left.lastActiveAt ?? left.createdAt;
			const rightRecent = right.lastActiveAt ?? right.createdAt;
			return rightRecent - leftRecent;
		}),
);

let selectedUser = $derived(
	filteredUsers.find((user) => user.id === selectedUserId) ??
		filteredUsers[0] ??
		null,
);

$effect(() => {
	const nextSelected = selectedUser?.id ?? null;
	if (selectedUserId !== nextSelected) {
		selectedUserId = nextSelected;
	}
});
</script>

<section class="settings-card mb-4">
	<div class="users-pane-header grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
		<div class="users-pane-copy min-w-0">
			<h2 class="settings-section-title mb-1">{$t('admin.users')}</h2>
			<p class="users-pane-subtext text-sm leading-6 text-text-secondary">
				{$t('admin.usersDescription')}
			</p>
		</div>
		<div class="grid w-full gap-2 sm:grid-cols-2 xl:w-auto xl:justify-self-end">
			<button class="btn-secondary w-full whitespace-nowrap" onclick={onReload} disabled={usersLoading}>
				{usersLoading ? $t('common.loading') : $t('admin.refresh')}
			</button>
			<button class="btn-primary w-full whitespace-nowrap" onclick={onOpenCreateUser}>{$t('admin.createUser')}</button>
		</div>
	</div>

	<div class="mt-5 grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
		<div class="rounded-xl border border-border bg-surface-page/70 p-3 sm:p-4">
			<div class="mb-3 flex flex-col gap-2">
				<input
					type="text"
					class="settings-input min-w-0"
					bind:value={search}
					placeholder={$t('admin.searchByNameOrEmail')}
				/>
				<div class="grid grid-cols-2 gap-2">
					<select class="settings-input min-w-0" bind:value={roleFilter}>
						<option value="all">{$t('admin.allRoles')}</option>
						<option value="admin">{$t('admin.admins')}</option>
						<option value="user">{$t('admin.usersRole')}</option>
					</select>
					<select class="settings-input min-w-0" bind:value={sortKey}>
						<option value="recent">{$t('admin.mostRecent')}</option>
						<option value="messages">{$t('admin.mostMessages')}</option>
						<option value="conversations">{$t('admin.mostChats')}</option>
						<option value="tokens">{$t('admin.mostTokens')}</option>
					</select>
				</div>
			</div>

			{#if usersMessage}
				<p class="mb-3 text-sm text-success">{usersMessage}</p>
			{/if}
			{#if usersError}
				<p class="mb-3 text-sm text-danger">{usersError}</p>
			{/if}

			{#if usersLoading}
				<div class="rounded-lg border border-dashed border-border px-4 py-8 text-sm text-text-muted">
					{$t('admin.loadingUsers')}
				</div>
			{:else if filteredUsers.length === 0}
				<div class="rounded-lg border border-dashed border-border px-4 py-8 text-sm text-text-muted">
					{$t('admin.noUsersMatch')}
				</div>
			{:else}
				<div class="max-h-[min(65vh,40rem)] space-y-2 overflow-y-auto pr-1">
					{#each filteredUsers as user}
						<button
							type="button"
							class={`w-full rounded-xl border px-4 py-3 text-left transition ${
								selectedUser?.id === user.id
									? 'border-accent bg-accent/8'
									: 'border-border bg-surface-overlay hover:border-accent/40 hover:bg-surface-elevated'
							}`}
							data-testid="admin-user-row"
							data-user-id={user.id}
							onclick={() => (selectedUserId = user.id)}
						>
							<div class="flex flex-col items-start gap-2">
								<div class="rounded-full border border-border px-2 py-0.5 text-[0.68rem] uppercase tracking-[0.14em] text-text-muted">
									{user.role}
								</div>
								<div class="min-w-0">
									<div class="truncate font-medium text-text-primary">{userLabel(user)}</div>
									<div class="truncate text-xs text-text-muted">{user.email}</div>
								</div>
							</div>
							<div class="mt-3 text-[0.72rem] text-text-muted">
								{#if user.lastActiveAt}
									{$t('admin.lastActive')} {formatDate(user.lastActiveAt)}
								{:else}
									{$t('admin.joined')} {formatDate(user.createdAt)}
								{/if}
							</div>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="rounded-xl border border-border bg-surface-page/70 p-4 sm:p-5">
			{#if selectedUser}
				<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div>
						<h3 class="text-lg font-semibold text-text-primary">{userLabel(selectedUser)}</h3>
						<p class="text-sm text-text-secondary">{selectedUser.email}</p>
					</div>
					<div class="rounded-full border border-border px-2.5 py-1 text-[0.68rem] uppercase tracking-[0.14em] text-text-muted">
						{selectedUser.role}
					</div>
				</div>

				<div class="mt-4 grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
					<div class="stat-card">
						<div class="stat-value">{formatCount(selectedUser.conversationCount)}</div>
						<div class="stat-label">{$t('admin.conversations')}</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{formatCount(selectedUser.messageCount)}</div>
						<div class="stat-label">{$t('admin.messages')}</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{formatCount(selectedUser.completionTokens)}</div>
						<div class="stat-label">{$t('admin.completionTokens')}</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{formatCount(selectedUser.reasoningTokens)}</div>
						<div class="stat-label">{$t('admin.reasoningTokens')}</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{formatCount(selectedUser.totalTokenCount)}</div>
						<div class="stat-label">{$t('admin.totalTokens')}</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">{formatCount(selectedUser.activeSessionCount)}</div>
						<div class="stat-label">{$t('admin.activeSessions')}</div>
					</div>
				</div>

				<div class="mt-4 grid gap-3 rounded-xl border border-border bg-surface-overlay p-4 text-sm text-text-secondary sm:grid-cols-2 xl:grid-cols-3">
					<div class="space-y-1">
						<span>{$t('admin.favoriteModel')}</span>
						<div class="text-text-primary">{modelDisplayName(selectedUser.favoriteModel)}</div>
					</div>
					<div class="space-y-1">
						<span>{$t('admin.joined')}</span>
						<div class="text-text-primary">{formatDate(selectedUser.createdAt)}</div>
					</div>
					<div class="space-y-1">
						<span>{$t('admin.lastActive')}</span>
						<div class="text-text-primary">{formatDate(selectedUser.lastActiveAt)}</div>
					</div>
				</div>

				<div class="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
					<button
						class="btn-secondary w-full whitespace-nowrap"
						disabled={actionUserId === selectedUser.id || selectedUser.id === currentUserId}
						onclick={() =>
							selectedUser.role === 'admin'
								? onDemoteUser(selectedUser.id)
								: onPromoteUser(selectedUser.id)}
					>
						{#if actionUserId === selectedUser.id}
							{$t('common.saving')}
						{:else if selectedUser.role === 'admin'}
							{$t('admin.demoteToUser')}
						{:else}
							{$t('admin.promoteToAdmin')}
						{/if}
					</button>
					<button
						class="btn-secondary w-full whitespace-nowrap"
						disabled={actionUserId === selectedUser.id || selectedUser.id === currentUserId}
						onclick={() => onRevokeSessions(selectedUser.id)}
					>
						{actionUserId === selectedUser.id ? $t('admin.working') : $t('admin.revokeSessions')}
					</button>
					<button
						class="btn-danger w-full whitespace-nowrap"
						disabled={actionUserId === selectedUser.id || selectedUser.id === currentUserId}
						onclick={() => (deleteCandidateId = selectedUser.id)}
					>
						{$t('admin.deleteUser')}
					</button>
				</div>

				{#if selectedUser.id === currentUserId}
					<p class="mt-3 text-xs text-text-muted">
						{$t('admin.profileTabNote')}
					</p>
				{/if}
			{:else}
				<div class="flex h-full items-center justify-center rounded-lg border border-dashed border-border px-4 py-10 text-sm text-text-muted">
					{$t('admin.selectUser')}
				</div>
			{/if}
		</div>
	</div>
</section>

{#if deleteCandidateId}
	<ConfirmDialog
		title={$t('settings_deleteUserTitle')}
		message={$t('settings_deleteUserMessage')}
		confirmText={$t('settings_deleteUserBtn')}
		confirmVariant="danger"
		onCancel={() => (deleteCandidateId = null)}
		onConfirm={() => {
			const targetUserId = deleteCandidateId;
			deleteCandidateId = null;
			if (targetUserId) {
				void onDeleteUser(targetUserId);
			}
		}}
	/>
{/if}

<style>
	.users-pane-copy {
		max-width: 42rem;
	}

	.users-pane-subtext {
		width: 100%;
		max-width: none;
		white-space: normal;
		overflow-wrap: break-word;
	}
</style>
