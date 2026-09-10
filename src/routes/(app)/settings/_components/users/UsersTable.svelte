<script lang="ts">
import { ChevronRight } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { AdminManagedUserSummary } from "$lib/server/services/user-admin";
import {
	describeLastActive,
	formatCompactNumber,
	formatCount,
	type UserSort,
	type UserSortKey,
	userInitials,
	userLabel,
} from "./users-table";

let {
	users,
	selectedUserId = null,
	currentUserId,
	sort,
	now = Date.now(),
	onSelect,
	onSortChange,
}: {
	users: AdminManagedUserSummary[];
	selectedUserId?: string | null;
	currentUserId: string;
	sort: UserSort;
	now?: number;
	onSelect: (userId: string) => void;
	onSortChange: (key: UserSortKey) => void;
} = $props();

const columns: Array<{
	key: UserSortKey;
	labelKey:
		| "admin.users.column.name"
		| "admin.users.column.email"
		| "admin.users.column.role"
		| "admin.users.column.lastActive"
		| "admin.users.column.messages"
		| "admin.users.column.tokens";
	numeric: boolean;
}> = [
	{ key: "name", labelKey: "admin.users.column.name", numeric: false },
	{ key: "email", labelKey: "admin.users.column.email", numeric: false },
	{ key: "role", labelKey: "admin.users.column.role", numeric: false },
	{ key: "recent", labelKey: "admin.users.column.lastActive", numeric: false },
	{ key: "messages", labelKey: "admin.users.column.messages", numeric: true },
	{ key: "tokens", labelKey: "admin.users.column.tokens", numeric: true },
];

function lastActiveText(user: AdminManagedUserSummary): string {
	const descriptor = describeLastActive(user.lastActiveAt, now);
	switch (descriptor.kind) {
		case "never":
			return $t("admin.users.lastActive.never");
		case "now":
			return $t("admin.users.lastActive.now");
		case "minutes":
			return $t("admin.users.lastActive.minutes", { count: descriptor.value });
		case "hours":
			return $t("admin.users.lastActive.hours", { count: descriptor.value });
		case "yesterday":
			return $t("admin.users.lastActive.yesterday");
		case "days":
			return $t("admin.users.lastActive.days", { count: descriptor.value });
		default:
			return new Intl.DateTimeFormat(undefined, {
				dateStyle: "medium",
			}).format(new Date(descriptor.value));
	}
}

function sortDirectionLabel(key: UserSortKey): string {
	if (sort.key !== key) return $t("admin.users.sortColumn");
	return sort.direction === "asc"
		? $t("admin.users.sortAscending")
		: $t("admin.users.sortDescending");
}
</script>

<div class="users-table-scroll">
	<table class="users-table">
		<thead>
			<tr>
				{#each columns as column (column.key)}
					<th class:numeric={column.numeric} scope="col">
						<button
							type="button"
							class="sort-button"
							class:sort-active={sort.key === column.key}
							aria-label={`${$t(column.labelKey)} — ${sortDirectionLabel(column.key)}`}
							onclick={() => onSortChange(column.key)}
						>
							<span>{$t(column.labelKey)}</span>
							<span class="sort-caret" aria-hidden="true">
								{#if sort.key === column.key}
									{sort.direction === 'asc' ? '▲' : '▼'}
								{/if}
							</span>
						</button>
					</th>
				{/each}
				<th class="chevron-col"><span class="sr-only">{$t('admin.users.detailsColumn')}</span></th>
			</tr>
		</thead>
		<tbody>
			{#each users as user (user.id)}
				<tr
					class="user-row"
					class:selected={selectedUserId === user.id}
					data-testid="admin-user-row"
					data-user-id={user.id}
					aria-selected={selectedUserId === user.id}
				>
					<td class="name-cell">
						<button
							type="button"
							class="row-select"
							aria-pressed={selectedUserId === user.id}
							onclick={() => onSelect(user.id)}
						>
							<span class="avatar" aria-hidden="true">{userInitials(user)}</span>
							<span class="row-name">{userLabel(user)}</span>
							{#if user.id === currentUserId}
								<span class="pill pill-outline">{$t('admin.users.you')}</span>
							{/if}
						</button>
					</td>
					<td class="email-cell">{user.email}</td>
					<td>
						<span class="pill" class:pill-accent={user.role === 'admin'} class:pill-outline={user.role !== 'admin'}>
							{user.role === 'admin' ? $t('admin.admin') : $t('admin.user')}
						</span>
					</td>
					<td class="last-active-cell" class:never={!user.lastActiveAt}>{lastActiveText(user)}</td>
					<td class="numeric">{formatCount(user.messageCount)}</td>
					<td class="numeric">{formatCompactNumber(user.totalTokenCount)}</td>
					<td class="chevron-col" aria-hidden="true"><ChevronRight size={14} strokeWidth={2} /></td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.users-table-scroll {
		overflow-x: auto;
	}

	.users-table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm);
	}

	.users-table th {
		border-bottom: 1px solid var(--border-default);
		padding: 0 var(--space-sm) var(--space-sm) 0;
		text-align: left;
		font-size: var(--text-2xs);
		font-weight: 600;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.users-table th:first-child,
	.users-table td:first-child {
		padding-left: var(--space-sm);
	}

	.users-table td {
		border-bottom: 1px solid var(--border-subtle);
		padding: 0.5rem var(--space-sm) 0.5rem 0;
		color: var(--text-secondary);
		vertical-align: middle;
	}

	.users-table th.numeric,
	.users-table td.numeric {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.chevron-col {
		width: 26px;
		color: var(--text-muted);
	}

	.sort-button {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		border: none;
		background: none;
		padding: 0;
		color: inherit;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
		border-radius: var(--radius-sm);
		transition: color var(--duration-standard) var(--ease-out);
	}

	.sort-button:hover {
		color: var(--accent);
	}

	.sort-button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.sort-active {
		color: var(--text-primary);
	}

	.sort-caret {
		display: inline-block;
		min-width: 0.6rem;
		font-size: 0.55rem;
		line-height: 1;
		color: var(--accent);
	}

	/* Rows are positioned so the name-cell button can stretch across the whole
	   row: one real <button> keeps the row keyboard-reachable and named, while
	   the overlay makes every cell clickable. */
	.user-row {
		position: relative;
		transition: background var(--duration-standard) var(--ease-out);
	}

	.user-row:hover td {
		background: color-mix(in srgb, var(--surface-elevated) 70%, transparent);
	}

	.user-row.selected td {
		background: color-mix(in srgb, var(--accent) 7%, transparent);
	}

	.user-row.selected td:first-child {
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.name-cell {
		color: var(--text-primary);
	}

	.row-select {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		border: none;
		background: none;
		padding: 0;
		color: var(--text-primary);
		font: inherit;
		text-align: left;
		cursor: pointer;
		border-radius: var(--radius-sm);
	}

	.row-select::after {
		content: "";
		position: absolute;
		inset: 0;
	}

	.row-select:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.row-name {
		font-weight: 500;
	}

	.avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-size: 0.66rem;
		font-weight: 700;
	}

	.email-cell {
		font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
		color: var(--text-primary);
	}

	.last-active-cell {
		font-size: var(--text-2xs);
		white-space: nowrap;
	}

	.last-active-cell.never {
		color: var(--text-muted);
		opacity: 0.85;
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
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
		margin-left: 0.25rem;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border-width: 0;
	}
</style>
