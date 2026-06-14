<script lang="ts">
import type { ModelId, UserRole } from "$lib/types";
import {
	createAdminUser,
	deleteAdminUser,
	fetchAdminUsers,
	revokeAdminUserSessions,
	updateAdminUserRole,
} from "$lib/client/api/settings";
import { t } from "$lib/i18n";
import CreateUserModal from "./CreateUserModal.svelte";
import SettingsAdminCampaignsPane from "./SettingsAdminCampaignsPane.svelte";
import SettingsAdminSystemPane from "./SettingsAdminSystemPane.svelte";
import SettingsAdminUsersPane from "./SettingsAdminUsersPane.svelte";

type AdminPane = "system" | "users" | "campaigns";

let {
	currentUserId,
	modelNames,
	availableModels = [],
	adminConfig = $bindable(),
	envDefaults = {},
	adminSaving = false,
	adminMessage = "",
	adminError = "",
	honchoHealth = null,
	honchoLoading = false,
	onCheckHonchoHealth,
	onSaveAdminConfig,
}: {
	currentUserId: string;
	modelNames: Record<string, string>;
	availableModels?: Array<{
		id: ModelId;
		displayName: string;
		iconUrl?: string | null;
	}>;
	adminConfig: Record<string, string>;
	envDefaults?: Record<string, string>;
	adminSaving?: boolean;
	adminMessage?: string;
	adminError?: string;
	honchoHealth?: {
		enabled: boolean;
		connected: boolean;
		workspace: string | null;
	} | null;
	honchoLoading?: boolean;
	onCheckHonchoHealth: () => void | Promise<void>;
	onSaveAdminConfig: () => void | Promise<void>;
} = $props();

let activePane = $state<AdminPane>("system");
let adminUsers = $state(awaitedEmptyUsers());
let usersLoaded = $state(false);
let usersLoading = $state(false);
let usersError = $state("");
let usersMessage = $state("");
let selectedUserId = $state<string | null>(null);
let actionUserId = $state<string | null>(null);

let showCreateUserModal = $state(false);
let createName = $state("");
let createEmail = $state("");
let createPassword = $state("");
let createRole = $state<UserRole>("user");
let showCreatePassword = $state(false);
let createLoading = $state(false);
let createError = $state("");

function awaitedEmptyUsers() {
	return [] as Awaited<ReturnType<typeof fetchAdminUsers>>;
}

function closeCreateUserModal() {
	showCreateUserModal = false;
	createName = "";
	createEmail = "";
	createPassword = "";
	createRole = "user";
	showCreatePassword = false;
	createError = "";
}

function syncSelectedUser(
	nextUsers: Awaited<ReturnType<typeof fetchAdminUsers>>,
	preferredId = selectedUserId,
) {
	selectedUserId =
		(preferredId && nextUsers.some((user) => user.id === preferredId)
			? preferredId
			: null) ??
		nextUsers[0]?.id ??
		null;
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

async function loadUsers(
	force = false,
	preferredId: string | null = selectedUserId,
) {
	if (usersLoaded && !force) return;

	usersLoading = true;
	usersError = "";
	try {
		const nextUsers = await fetchAdminUsers();
		adminUsers = nextUsers;
		usersLoaded = true;
		syncSelectedUser(nextUsers, preferredId);
	} catch (error: unknown) {
		usersError = errorMessage(error, "Failed to load users.");
	} finally {
		usersLoading = false;
	}
}

async function openPane(nextPane: AdminPane) {
	activePane = nextPane;
	if (nextPane === "users") {
		await loadUsers();
	}
}

async function refreshUsers(preferredId: string | null = selectedUserId) {
	await loadUsers(true, preferredId);
}

async function handleCreateUser() {
	createLoading = true;
	createError = "";
	usersMessage = "";
	usersError = "";
	try {
		const created = await createAdminUser({
			name: createName.trim() || null,
			email: createEmail,
			password: createPassword,
			role: createRole,
		});
		closeCreateUserModal();
		usersMessage = `Created ${created.email}.`;
		await refreshUsers(created.id);
	} catch (error: unknown) {
		createError = errorMessage(error, "Failed to create user.");
	} finally {
		createLoading = false;
	}
}

async function runUserAction(
	userId: string,
	action: () => Promise<unknown>,
	successMessage: string,
	preferredId: string | null = userId,
) {
	actionUserId = userId;
	usersMessage = "";
	usersError = "";
	try {
		await action();
		usersMessage = successMessage;
		await refreshUsers(preferredId);
	} catch (error: unknown) {
		usersError = errorMessage(error, "User action failed.");
	} finally {
		actionUserId = null;
	}
}

async function handlePromoteUser(userId: string) {
	await runUserAction(
		userId,
		() => updateAdminUserRole(userId, "admin"),
		"Admin access granted.",
	);
}

async function handleDemoteUser(userId: string) {
	await runUserAction(
		userId,
		() => updateAdminUserRole(userId, "user"),
		"Admin access removed.",
	);
}

async function handleRevokeSessions(userId: string) {
	await runUserAction(
		userId,
		() => revokeAdminUserSessions(userId),
		"Active sessions revoked.",
	);
}

async function handleDeleteUser(userId: string) {
	await runUserAction(
		userId,
		() => deleteAdminUser(userId),
		"User deleted.",
		selectedUserId === userId ? null : selectedUserId,
	);
}
</script>

<div class="mb-4 flex gap-1 rounded-lg border border-border bg-surface-overlay p-1">
	<button
		class="tab-btn flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
		class:tab-active={activePane === 'system'}
		onclick={() => openPane('system')}
	>
		{$t('settings_systemTab')}
	</button>
	<button
		class="tab-btn flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
		class:tab-active={activePane === 'users'}
		onclick={() => openPane('users')}
	>
		{$t('settings_usersTab')}
	</button>
	<button
		class="tab-btn flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
		class:tab-active={activePane === 'campaigns'}
		onclick={() => openPane('campaigns')}
	>
		{$t('settings_campaignsTab')}
	</button>
</div>

{#if activePane === 'system'}
	<SettingsAdminSystemPane
		bind:adminConfig
		{envDefaults}
		{availableModels}
		{adminSaving}
		{adminMessage}
		{adminError}
		{honchoHealth}
		{honchoLoading}
		{onCheckHonchoHealth}
		{onSaveAdminConfig}
	/>
{:else if activePane === 'users'}
	<SettingsAdminUsersPane
		{currentUserId}
		{modelNames}
		users={adminUsers}
		{usersLoading}
		{usersError}
		{usersMessage}
		bind:selectedUserId
		{actionUserId}
		onReload={() => refreshUsers()}
		onOpenCreateUser={() => {
			createError = '';
			showCreateUserModal = true;
		}}
		onPromoteUser={handlePromoteUser}
		onDemoteUser={handleDemoteUser}
		onDeleteUser={handleDeleteUser}
		onRevokeSessions={handleRevokeSessions}
	/>
{:else}
	<SettingsAdminCampaignsPane />
{/if}

{#if showCreateUserModal}
	<CreateUserModal
		bind:name={createName}
		bind:email={createEmail}
		bind:password={createPassword}
		bind:role={createRole}
		bind:showPassword={showCreatePassword}
		{createLoading}
		{createError}
		onConfirm={handleCreateUser}
		onCancel={closeCreateUserModal}
	/>
{/if}

<style>
	.tab-btn {
		color: var(--text-secondary);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.tab-btn:hover {
		color: var(--text-primary);
		background: var(--surface-elevated);
	}

	.tab-active {
		color: var(--text-primary) !important;
		background: var(--surface-page) !important;
		font-weight: 600;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
	}
</style>
