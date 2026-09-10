/**
 * Pure table model for the admin Users screen.
 *
 * The redesign turns the 280px scrolling rail into a real, sortable, paginated
 * table, so filtering / sorting / paging / summary counting all live here as
 * plain functions the component only renders. Keeping them out of the .svelte
 * file is what makes them directly testable (users-table.test.ts) and stops the
 * old `$effect`-that-reassigns-the-selection pattern from creeping back.
 */

import type { AdminManagedUserSummary } from "$lib/server/services/user-admin";

export type UserRoleFilter = "all" | "user" | "admin";

/**
 * Sortable columns. The first four are the sort-select options the previous
 * screen shipped (kept, so no option is dropped); `name` / `email` / `role`
 * are the extra column headers the table adds.
 */
export type UserSortKey =
	| "recent"
	| "messages"
	| "conversations"
	| "tokens"
	| "name"
	| "email"
	| "role";

export type SortDirection = "asc" | "desc";

export type UserSort = {
	key: UserSortKey;
	direction: SortDirection;
};

export const DEFAULT_USER_SORT: UserSort = { key: "recent", direction: "desc" };

export const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100] as const;

/** Numeric / recency columns read best largest-first; text columns A→Z. */
const DEFAULT_DIRECTION: Record<UserSortKey, SortDirection> = {
	recent: "desc",
	messages: "desc",
	conversations: "desc",
	tokens: "desc",
	name: "asc",
	email: "asc",
	role: "asc",
};

export function userLabel(user: AdminManagedUserSummary): string {
	return user.name?.trim() || user.email;
}

export function userInitials(user: AdminManagedUserSummary): string {
	const label = userLabel(user).trim();
	// An email fallback initials off its local part only, so "anna@alfy.hu"
	// reads as AN rather than borrowing a letter from the domain.
	const source = label.includes("@") ? label.split("@")[0] : label;
	if (!source) return "?";
	const words = source.split(/[\s._-]+/).filter(Boolean);
	if (words.length === 0) return source.slice(0, 2).toUpperCase();
	if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
	return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

export function matchesUserSearch(
	user: AdminManagedUserSummary,
	query: string,
): boolean {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) return true;
	return `${user.name ?? ""} ${user.email}`.toLowerCase().includes(trimmed);
}

export function filterUsers(
	users: AdminManagedUserSummary[],
	options: { search?: string; role?: UserRoleFilter } = {},
): AdminManagedUserSummary[] {
	const role = options.role ?? "all";
	const search = options.search ?? "";
	return users
		.filter((user) => (role === "all" ? true : user.role === role))
		.filter((user) => matchesUserSearch(user, search));
}

function recencyOf(user: AdminManagedUserSummary): number {
	return user.lastActiveAt ?? user.createdAt ?? 0;
}

function compareText(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function compareBy(
	key: UserSortKey,
	left: AdminManagedUserSummary,
	right: AdminManagedUserSummary,
): number {
	switch (key) {
		case "messages":
			return left.messageCount - right.messageCount;
		case "conversations":
			return left.conversationCount - right.conversationCount;
		case "tokens":
			return left.totalTokenCount - right.totalTokenCount;
		case "name":
			return compareText(userLabel(left), userLabel(right));
		case "email":
			return compareText(left.email, right.email);
		case "role":
			return compareText(left.role, right.role);
		default:
			return recencyOf(left) - recencyOf(right);
	}
}

export function sortUsers(
	users: AdminManagedUserSummary[],
	sort: UserSort = DEFAULT_USER_SORT,
): AdminManagedUserSummary[] {
	const factor = sort.direction === "asc" ? 1 : -1;
	return [...users].sort((left, right) => {
		const primary = compareBy(sort.key, left, right) * factor;
		if (primary !== 0) return primary;
		// Stable, meaningful tiebreak so equal counts never shuffle between
		// renders (a row jumping under the cursor was an old complaint).
		return compareText(userLabel(left), userLabel(right));
	});
}

/** The natural sort for a column, used by the sort select. */
export function sortForKey(key: UserSortKey): UserSort {
	return { key, direction: DEFAULT_DIRECTION[key] };
}

/**
 * Clicking the column that is already sorted flips the direction; clicking a
 * new column starts from that column's natural direction.
 */
export function nextSortForColumn(
	current: UserSort,
	key: UserSortKey,
): UserSort {
	if (current.key !== key) {
		return { key, direction: DEFAULT_DIRECTION[key] };
	}
	return {
		key,
		direction: current.direction === "asc" ? "desc" : "asc",
	};
}

export type PageResult<T> = {
	rows: T[];
	page: number;
	pageCount: number;
	total: number;
	/** 1-based index of the first row on this page (0 when empty). */
	from: number;
	/** 1-based index of the last row on this page (0 when empty). */
	to: number;
};

export function paginate<T>(
	rows: T[],
	page: number,
	perPage: number,
): PageResult<T> {
	const size = Math.max(1, Math.floor(perPage) || 1);
	const total = rows.length;
	const pageCount = Math.max(1, Math.ceil(total / size));
	const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
	const start = (safePage - 1) * size;
	const pageRows = rows.slice(start, start + size);
	return {
		rows: pageRows,
		page: safePage,
		pageCount,
		total,
		from: total === 0 ? 0 : start + 1,
		to: total === 0 ? 0 : start + pageRows.length,
	};
}

export type UserAccountSummary = {
	total: number;
	admins: number;
	neverSignedIn: number;
};

export function summarizeAccounts(
	users: AdminManagedUserSummary[],
): UserAccountSummary {
	return {
		total: users.length,
		admins: users.filter((user) => user.role === "admin").length,
		neverSignedIn: users.filter((user) => !user.lastActiveAt).length,
	};
}

export type LastActiveDescriptor =
	| { kind: "never" }
	| { kind: "now" }
	| { kind: "minutes"; value: number }
	| { kind: "hours"; value: number }
	| { kind: "yesterday" }
	| { kind: "days"; value: number }
	| { kind: "date"; value: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Turns a timestamp into a *descriptor* rather than a string: the component
 * maps it to a translated phrase, so "2 min ago" / "3 d ago" exist in both
 * dictionaries instead of being hard-coded English here.
 */
export function describeLastActive(
	timestamp: number | null | undefined,
	now: number = Date.now(),
): LastActiveDescriptor {
	if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) {
		return { kind: "never" };
	}
	const elapsed = Math.max(0, now - timestamp);
	if (elapsed < MINUTE) return { kind: "now" };
	if (elapsed < HOUR)
		return { kind: "minutes", value: Math.floor(elapsed / MINUTE) };
	if (elapsed < DAY)
		return { kind: "hours", value: Math.floor(elapsed / HOUR) };
	if (elapsed < 2 * DAY) return { kind: "yesterday" };
	if (elapsed < 30 * DAY)
		return { kind: "days", value: Math.floor(elapsed / DAY) };
	return { kind: "date", value: timestamp };
}

/** 18_400_000 -> "18.4M", 210_000 -> "210K", 96 -> "96". */
export function formatCompactNumber(value: number, locale?: string): string {
	if (!Number.isFinite(value)) return "—";
	if (Math.abs(value) < 1000) return value.toLocaleString(locale);
	return new Intl.NumberFormat(locale, {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}

export function formatCount(value: number, locale?: string): string {
	if (!Number.isFinite(value)) return "—";
	return value.toLocaleString(locale);
}

/**
 * Share of the token total each half represents, for the hero stat's split
 * bar. Falls back to an even split only when there is nothing to divide, so
 * the bar never collapses to a zero-width flex row.
 */
export function tokenSplit(
	completionTokens: number,
	reasoningTokens: number,
): { completion: number; reasoning: number } {
	const completion = Math.max(0, completionTokens || 0);
	const reasoning = Math.max(0, reasoningTokens || 0);
	if (completion + reasoning === 0) return { completion: 1, reasoning: 0 };
	return { completion, reasoning };
}
