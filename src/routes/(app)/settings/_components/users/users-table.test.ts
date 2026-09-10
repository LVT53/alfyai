import { describe, expect, it } from "vitest";
import type { AdminManagedUserSummary } from "$lib/server/services/user-admin";
import {
	DEFAULT_USER_SORT,
	describeLastActive,
	filterUsers,
	formatCompactNumber,
	nextSortForColumn,
	paginate,
	sortForKey,
	sortUsers,
	summarizeAccounts,
	tokenSplit,
	userInitials,
	userLabel,
} from "./users-table";

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

function user(
	overrides: Partial<AdminManagedUserSummary> & { id: string },
): AdminManagedUserSummary {
	return {
		id: overrides.id,
		email: overrides.email ?? `${overrides.id}@alfy.hu`,
		name: overrides.name ?? null,
		role: overrides.role ?? "user",
		createdAt: overrides.createdAt ?? NOW - 90 * 24 * 3600_000,
		lastActiveAt:
			"lastActiveAt" in overrides ? overrides.lastActiveAt : NOW - 3600_000,
		conversationCount: overrides.conversationCount ?? 0,
		messageCount: overrides.messageCount ?? 0,
		completionTokens: overrides.completionTokens ?? 0,
		reasoningTokens: overrides.reasoningTokens ?? 0,
		totalTokenCount: overrides.totalTokenCount ?? 0,
		activeSessionCount: overrides.activeSessionCount ?? 0,
		favoriteModel: overrides.favoriteModel ?? null,
	} as AdminManagedUserSummary;
}

const kata = user({
	id: "kata",
	name: "Kata Bíró",
	email: "kata.biro@alfy.hu",
	messageCount: 1204,
	totalTokenCount: 3_940_000,
	conversationCount: 96,
	lastActiveAt: NOW - 3600_000,
});
const levente = user({
	id: "levente",
	name: "Levente Alf",
	email: "levente.alf@icloud.com",
	role: "admin",
	messageCount: 4812,
	totalTokenCount: 18_400_000,
	conversationCount: 240,
	lastActiveAt: NOW - 2 * 60_000,
});
const julia = user({
	id: "julia",
	name: "Júlia Fekete",
	email: "julia.fekete@alfy.hu",
	messageCount: 0,
	totalTokenCount: 0,
	lastActiveAt: null,
});

const everyone = [kata, levente, julia];

describe("filterUsers", () => {
	it("keeps everyone when no filters are set", () => {
		expect(filterUsers(everyone)).toHaveLength(3);
	});

	it("filters by role", () => {
		expect(filterUsers(everyone, { role: "admin" }).map((u) => u.id)).toEqual([
			"levente",
		]);
		expect(filterUsers(everyone, { role: "user" }).map((u) => u.id)).toEqual([
			"kata",
			"julia",
		]);
	});

	it("matches the search against name and email, case-insensitively", () => {
		expect(
			filterUsers(everyone, { search: "  BÍRÓ " }).map((u) => u.id),
		).toEqual(["kata"]);
		expect(
			filterUsers(everyone, { search: "icloud" }).map((u) => u.id),
		).toEqual(["levente"]);
		expect(filterUsers(everyone, { search: "nobody" })).toEqual([]);
	});
});

describe("sortUsers", () => {
	it("defaults to most recently active first", () => {
		expect(sortUsers(everyone, DEFAULT_USER_SORT).map((u) => u.id)).toEqual([
			"levente",
			"kata",
			"julia",
		]);
	});

	it("sorts by every numeric column in both directions", () => {
		expect(
			sortUsers(everyone, { key: "messages", direction: "desc" }).map(
				(u) => u.id,
			),
		).toEqual(["levente", "kata", "julia"]);
		expect(
			sortUsers(everyone, { key: "messages", direction: "asc" }).map(
				(u) => u.id,
			),
		).toEqual(["julia", "kata", "levente"]);
		expect(
			sortUsers(everyone, { key: "tokens", direction: "desc" }).map(
				(u) => u.id,
			),
		).toEqual(["levente", "kata", "julia"]);
		expect(
			sortUsers(everyone, { key: "conversations", direction: "desc" }).map(
				(u) => u.id,
			),
		).toEqual(["levente", "kata", "julia"]);
	});

	it("sorts text columns alphabetically", () => {
		expect(
			sortUsers(everyone, { key: "name", direction: "asc" }).map((u) => u.id),
		).toEqual(["julia", "kata", "levente"]);
		expect(
			sortUsers(everyone, { key: "email", direction: "asc" }).map((u) => u.id),
		).toEqual(["julia", "kata", "levente"]);
		expect(
			sortUsers(everyone, { key: "role", direction: "asc" }).map((u) => u.role),
		).toEqual(["admin", "user", "user"]);
	});

	it("falls back to the display name so equal values never shuffle", () => {
		const a = user({ id: "a", name: "Zsolt", messageCount: 5 });
		const b = user({ id: "b", name: "Anna", messageCount: 5 });
		expect(
			sortUsers([a, b], { key: "messages", direction: "desc" }).map(
				(u) => u.id,
			),
		).toEqual(["b", "a"]);
	});

	it("does not mutate the input array", () => {
		const input = [...everyone];
		sortUsers(input, { key: "name", direction: "asc" });
		expect(input.map((u) => u.id)).toEqual(["kata", "levente", "julia"]);
	});
});

describe("nextSortForColumn", () => {
	it("starts a new column at its natural direction", () => {
		expect(nextSortForColumn(DEFAULT_USER_SORT, "name")).toEqual({
			key: "name",
			direction: "asc",
		});
		expect(nextSortForColumn(DEFAULT_USER_SORT, "tokens")).toEqual({
			key: "tokens",
			direction: "desc",
		});
	});

	it("flips the direction of the active column", () => {
		const first = nextSortForColumn(DEFAULT_USER_SORT, "messages");
		const second = nextSortForColumn(first, "messages");
		const third = nextSortForColumn(second, "messages");
		expect(second).toEqual({ key: "messages", direction: "asc" });
		expect(third).toEqual({ key: "messages", direction: "desc" });
	});

	it("exposes the same natural direction to the sort select", () => {
		expect(sortForKey("recent")).toEqual({ key: "recent", direction: "desc" });
		expect(sortForKey("email")).toEqual({ key: "email", direction: "asc" });
	});
});

describe("paginate", () => {
	const rows = Array.from({ length: 23 }, (_, index) => index);

	it("reports the visible range", () => {
		const page = paginate(rows, 1, 10);
		expect(page.rows).toHaveLength(10);
		expect(page).toMatchObject({
			page: 1,
			pageCount: 3,
			total: 23,
			from: 1,
			to: 10,
		});
	});

	it("clamps a page beyond the end", () => {
		const page = paginate(rows, 99, 10);
		expect(page.page).toBe(3);
		expect(page.rows).toEqual([20, 21, 22]);
		expect(page.from).toBe(21);
		expect(page.to).toBe(23);
	});

	it("survives an empty row set", () => {
		expect(paginate([], 1, 25)).toMatchObject({
			pageCount: 1,
			total: 0,
			from: 0,
			to: 0,
		});
	});
});

describe("summarizeAccounts", () => {
	it("counts accounts, admins and never-signed-in users", () => {
		expect(summarizeAccounts(everyone)).toEqual({
			total: 3,
			admins: 1,
			neverSignedIn: 1,
		});
	});
});

describe("describeLastActive", () => {
	it("describes the age of a timestamp", () => {
		expect(describeLastActive(null, NOW)).toEqual({ kind: "never" });
		expect(describeLastActive(NOW - 10_000, NOW)).toEqual({ kind: "now" });
		expect(describeLastActive(NOW - 2 * 60_000, NOW)).toEqual({
			kind: "minutes",
			value: 2,
		});
		expect(describeLastActive(NOW - 3 * 3600_000, NOW)).toEqual({
			kind: "hours",
			value: 3,
		});
		expect(describeLastActive(NOW - 30 * 3600_000, NOW)).toEqual({
			kind: "yesterday",
		});
		expect(describeLastActive(NOW - 12 * 86_400_000, NOW)).toEqual({
			kind: "days",
			value: 12,
		});
		const old = NOW - 120 * 86_400_000;
		expect(describeLastActive(old, NOW)).toEqual({ kind: "date", value: old });
	});
});

describe("formatting helpers", () => {
	it("formats large counts compactly", () => {
		expect(formatCompactNumber(96, "en-US")).toBe("96");
		expect(formatCompactNumber(210_000, "en-US")).toBe("210K");
		expect(formatCompactNumber(18_400_000, "en-US")).toBe("18.4M");
	});

	it("builds initials from names and falls back to the email", () => {
		expect(userInitials(kata)).toBe("KB");
		expect(
			userInitials(user({ id: "x", name: null, email: "anna@alfy.hu" })),
		).toBe("AN");
		expect(
			userInitials(user({ id: "x", name: "Bence", email: "b@a.hu" })),
		).toBe("BE");
	});

	it("labels a user by name, falling back to the email", () => {
		expect(userLabel(kata)).toBe("Kata Bíró");
		expect(userLabel(user({ id: "x", name: "  ", email: "b@a.hu" }))).toBe(
			"b@a.hu",
		);
	});

	it("keeps the token split bar visible when there is nothing to split", () => {
		expect(tokenSplit(2_710_000, 1_230_000)).toEqual({
			completion: 2_710_000,
			reasoning: 1_230_000,
		});
		expect(tokenSplit(0, 0)).toEqual({ completion: 1, reasoning: 0 });
	});
});
