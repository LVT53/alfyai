<script lang="ts">
import {
	ChevronLeft,
	ChevronRight,
	Plus,
	RefreshCw,
	Search,
} from "@lucide/svelte";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import { t } from "$lib/i18n";
import type { AdminManagedUserSummary } from "$lib/server/services/user-admin";
import UserDetailPanel from "./users/UserDetailPanel.svelte";
import UsersTable from "./users/UsersTable.svelte";
import {
	DEFAULT_USER_SORT,
	ROWS_PER_PAGE_OPTIONS,
	filterUsers,
	nextSortForColumn,
	paginate,
	sortForKey,
	sortUsers,
	summarizeAccounts,
	userLabel,
	type UserRoleFilter,
	type UserSort,
	type UserSortKey,
} from "./users/users-table";

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

const LEGACY_SORT_KEYS: UserSortKey[] = [
	"recent",
	"messages",
	"conversations",
	"tokens",
];

let search = $state("");
let roleFilter = $state<UserRoleFilter>("all");
let sort = $state<UserSort>({ ...DEFAULT_USER_SORT });
let page = $state(1);
let rowsPerPage = $state(25);
let deleteCandidateId = $state<string | null>(null);
let promoteCandidateId = $state<string | null>(null);
// Captured once so relative "2 min ago" labels stay stable while the admin
// reads the table, and refreshed whenever the list is reloaded.
let now = $state(Date.now());

let accounts = $derived(summarizeAccounts(users));
let matchingUsers = $derived(
	sortUsers(filterUsers(users, { search, role: roleFilter }), sort),
);
let pageResult = $derived(paginate(matchingUsers, page, rowsPerPage));
let selectedUser = $derived(
	users.find((user) => user.id === selectedUserId) ?? null,
);
let selectionHidden = $derived(
	Boolean(
		selectedUser && !matchingUsers.some((user) => user.id === selectedUser?.id),
	),
);
let deleteCandidate = $derived(
	users.find((user) => user.id === deleteCandidateId) ?? null,
);
let promoteCandidate = $derived(
	users.find((user) => user.id === promoteCandidateId) ?? null,
);
let legacySortValue = $derived(
	LEGACY_SORT_KEYS.includes(sort.key) ? sort.key : "custom",
);

function resetPage() {
	page = 1;
}

function handleSortColumn(key: UserSortKey) {
	sort = nextSortForColumn(sort, key);
	resetPage();
}

function handleSortSelect(event: Event) {
	const value = (event.currentTarget as HTMLSelectElement).value;
	if (value === "custom") return;
	sort = sortForKey(value as UserSortKey);
	resetPage();
}

async function reload() {
	now = Date.now();
	await onReload();
	now = Date.now();
}

function confirmPromote() {
	const targetId = promoteCandidateId;
	promoteCandidateId = null;
	if (targetId) void onPromoteUser(targetId);
}

function confirmDelete() {
	const targetId = deleteCandidateId;
	deleteCandidateId = null;
	if (targetId) void onDeleteUser(targetId);
}
</script>

<section class="settings-card mb-4" data-testid="admin-users-pane">
	<div class="users-header">
		<div class="min-w-0">
			<h2 class="settings-section-title !mb-1">{$t('admin.users')}</h2>
			<p class="users-summary">
				{$t('admin.users.accountSummary', {
					total: accounts.total,
					admins: accounts.admins,
					never: accounts.neverSignedIn,
				})}
			</p>
		</div>
		<div class="users-header-actions">
			<button type="button" class="btn-secondary gap-1.5 whitespace-nowrap" onclick={reload} disabled={usersLoading}>
				<RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
				{usersLoading ? $t('common.loading') : $t('admin.refresh')}
			</button>
			<button type="button" class="btn-primary gap-1.5 whitespace-nowrap" onclick={onOpenCreateUser}>
				<Plus size={14} strokeWidth={2} aria-hidden="true" />
				{$t('admin.createUser')}
			</button>
		</div>
	</div>

	<div class="users-toolbar">
		<div class="search-field">
			<Search size={14} strokeWidth={2} aria-hidden="true" />
			<input
				type="search"
				bind:value={search}
				oninput={resetPage}
				placeholder={$t('admin.searchByNameOrEmail')}
				aria-label={$t('admin.searchByNameOrEmail')}
			/>
		</div>
		<select
			class="settings-input toolbar-select"
			bind:value={roleFilter}
			onchange={resetPage}
			aria-label={$t('admin.allRoles')}
		>
			<option value="all">{$t('admin.allRoles')}</option>
			<option value="admin">{$t('admin.admins')}</option>
			<option value="user">{$t('admin.usersRole')}</option>
		</select>
		<select
			class="settings-input toolbar-select toolbar-select-wide"
			value={legacySortValue}
			onchange={handleSortSelect}
			aria-label={$t('admin.users.sortLabel')}
		>
			<option value="recent">{$t('admin.mostRecent')}</option>
			<option value="messages">{$t('admin.mostMessages')}</option>
			<option value="conversations">{$t('admin.mostChats')}</option>
			<option value="tokens">{$t('admin.mostTokens')}</option>
			{#if legacySortValue === 'custom'}
				<option value="custom">{$t('admin.users.sortCustom')}</option>
			{/if}
		</select>
		<span class="flex-1"></span>
		<span class="showing-count">
			{#if pageResult.total > 0}
				{$t('admin.users.showingRange', {
					from: pageResult.from,
					to: pageResult.to,
					total: pageResult.total,
				})}
			{:else}
				{$t('admin.users.showingNone')}
			{/if}
		</span>
	</div>

	<div class="users-body">
		<div class="table-card">
			{#if usersLoading && users.length === 0}
				<div class="table-placeholder">{$t('admin.loadingUsers')}</div>
			{:else if pageResult.total === 0}
				<div class="table-placeholder">{$t('admin.noUsersMatch')}</div>
			{:else}
				<UsersTable
					users={pageResult.rows}
					{selectedUserId}
					{currentUserId}
					{sort}
					{now}
					onSelect={(userId) => (selectedUserId = userId)}
					onSortChange={handleSortColumn}
				/>
			{/if}

			<div class="pager">
				<label class="pager-rows">
					{$t('admin.users.rowsPerPage')}
					<select
						class="settings-input pager-select"
						bind:value={rowsPerPage}
						onchange={resetPage}
					>
						{#each ROWS_PER_PAGE_OPTIONS as option (option)}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</label>
				<span class="flex-1"></span>
				<button
					type="button"
					class="mini-btn"
					disabled={pageResult.page <= 1}
					onclick={() => (page = pageResult.page - 1)}
				>
					<ChevronLeft size={11} strokeWidth={2} aria-hidden="true" />
					{$t('admin.users.previousPage')}
				</button>
				<span class="pager-page" aria-live="polite">
					{$t('admin.users.pageOf', { page: pageResult.page, pageCount: pageResult.pageCount })}
				</span>
				<button
					type="button"
					class="mini-btn"
					disabled={pageResult.page >= pageResult.pageCount}
					onclick={() => (page = pageResult.page + 1)}
				>
					{$t('admin.users.nextPage')}
					<ChevronRight size={11} strokeWidth={2} aria-hidden="true" />
				</button>
			</div>
		</div>

		<div class="detail-column">
			<UserDetailPanel
				user={selectedUser}
				{currentUserId}
				{modelNames}
				{actionUserId}
				message={usersMessage}
				error={usersError}
				hiddenByFilter={selectionHidden}
				onPromote={(userId) => (promoteCandidateId = userId)}
				onDemote={(userId) => void onDemoteUser(userId)}
				onRevokeSessions={(userId) => void onRevokeSessions(userId)}
				onDelete={(userId) => (deleteCandidateId = userId)}
			/>
			{#if !selectedUser && (usersMessage || usersError)}
				<p class="detached-message" class:detached-error={Boolean(usersError)}>
					{usersError || usersMessage}
				</p>
			{/if}
		</div>
	</div>
</section>

{#if promoteCandidate}
	<ConfirmDialog
		title={$t('admin.users.promoteTitle', { name: userLabel(promoteCandidate) })}
		message={$t('admin.users.promoteMessage', { name: userLabel(promoteCandidate) })}
		confirmText={$t('admin.promoteToAdmin')}
		onCancel={() => (promoteCandidateId = null)}
		onConfirm={confirmPromote}
	/>
{/if}

{#if deleteCandidate}
	<ConfirmDialog
		title={$t('settings_deleteUserTitle')}
		message={$t('settings_deleteUserMessage')}
		confirmText={$t('settings_deleteUserBtn')}
		confirmVariant="danger"
		onCancel={() => (deleteCandidateId = null)}
		onConfirm={confirmDelete}
	/>
{/if}

<style>
	.users-header {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: var(--space-md);
		margin-bottom: 0.875rem;
	}

	.users-header > div:first-child {
		flex: 1 1 18rem;
	}

	.users-summary {
		margin-top: 3px;
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.users-header-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.users-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.625rem;
		margin-bottom: 0.75rem;
	}

	.search-field {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1 1 260px;
		max-width: 300px;
		min-height: 34px;
		padding: 0.35rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: var(--text-muted);
		transition: border-color var(--duration-standard) var(--ease-out);
	}

	.search-field:focus-within {
		border-color: var(--accent);
	}

	.search-field input {
		flex: 1 1 auto;
		min-width: 0;
		border: none;
		background: none;
		outline: none;
		color: var(--text-primary);
		font-size: var(--text-md);
	}

	.toolbar-select {
		width: auto;
		min-width: 9rem;
		min-height: 34px;
		cursor: pointer;
	}

	.toolbar-select-wide {
		min-width: 13rem;
	}

	.showing-count {
		font-size: var(--text-2xs);
		color: var(--text-muted);
		white-space: nowrap;
	}

	.users-body {
		display: grid;
		gap: var(--space-md);
		align-items: start;
		grid-template-columns: minmax(0, 1fr);
	}

	@media (min-width: 1180px) {
		.users-body {
			grid-template-columns: minmax(0, 1fr) 400px;
		}
	}

	.table-card {
		min-width: 0;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-overlay);
		padding: 0.75rem 0.625rem;
	}

	.table-placeholder {
		border: 1px dashed var(--border-default);
		border-radius: var(--radius-md);
		padding: 2rem 1rem;
		text-align: center;
		font-size: var(--text-md);
		color: var(--text-muted);
	}

	.pager {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.75rem 0;
		margin-top: 0.25rem;
		border-top: 1px solid var(--border-default);
	}

	.pager-rows {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.pager-select {
		width: auto;
		min-width: 4.5rem;
		padding: 0.25rem 0.5rem;
		cursor: pointer;
	}

	.pager-page {
		font-size: var(--text-2xs);
		color: var(--text-secondary);
		min-width: 3.5rem;
		text-align: center;
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
			color var(--duration-standard) var(--ease-out);
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

	.detail-column {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		min-width: 0;
	}

	.detached-message {
		font-size: var(--text-xs);
		color: var(--success);
	}

	.detached-error {
		color: var(--danger);
	}
</style>
