import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { AdminManagedUserSummary } from "$lib/server/services/user-admin";
import SettingsAdminUsersPane from "./SettingsAdminUsersPane.svelte";

const NOW = Date.now();

function user(
	overrides: Partial<AdminManagedUserSummary> & { id: string },
): AdminManagedUserSummary {
	return {
		email: `${overrides.id}@alfy.hu`,
		name: null,
		role: "user",
		createdAt: NOW - 90 * 86_400_000,
		lastActiveAt: NOW - 3_600_000,
		conversationCount: 0,
		messageCount: 0,
		completionTokens: 0,
		reasoningTokens: 0,
		totalTokenCount: 0,
		activeSessionCount: 0,
		favoriteModel: null,
		...overrides,
	} as AdminManagedUserSummary;
}

const users = [
	user({
		id: "levente",
		name: "Levente Alf",
		email: "levente.alf@icloud.com",
		role: "admin",
		messageCount: 4812,
		totalTokenCount: 18_400_000,
		completionTokens: 12_000_000,
		reasoningTokens: 6_400_000,
		conversationCount: 240,
		activeSessionCount: 1,
		lastActiveAt: NOW - 120_000,
	}),
	user({
		id: "kata",
		name: "Kata Bíró",
		email: "kata.biro@alfy.hu",
		messageCount: 1204,
		totalTokenCount: 3_940_000,
		completionTokens: 2_710_000,
		reasoningTokens: 1_230_000,
		conversationCount: 96,
		activeSessionCount: 2,
		lastActiveAt: NOW - 3_600_000,
	}),
	user({
		id: "julia",
		name: "Júlia Fekete",
		email: "julia.fekete@alfy.hu",
		lastActiveAt: null,
	}),
];

function renderPane(props: Record<string, unknown> = {}) {
	return render(SettingsAdminUsersPane, {
		props: {
			users,
			currentUserId: "levente",
			modelNames: { "flash-next": "Flash-Next 8B" },
			selectedUserId: "kata",
			onReload: vi.fn(),
			onOpenCreateUser: vi.fn(),
			onPromoteUser: vi.fn(),
			onDemoteUser: vi.fn(),
			onDeleteUser: vi.fn(),
			onRevokeSessions: vi.fn(),
			...props,
		},
	});
}

function rowNames(): string[] {
	return screen
		.getAllByTestId("admin-user-row")
		.map((row) => row.getAttribute("data-user-id") ?? "");
}

describe("SettingsAdminUsersPane", () => {
	it("renders one table row per user with an account summary", () => {
		renderPane();

		expect(rowNames()).toEqual(["levente", "kata", "julia"]);
		expect(
			screen.getByText("3 accounts · 1 admins · 1 never signed in"),
		).toBeInTheDocument();
		expect(screen.getByText("Showing 1–3 of 3")).toBeInTheDocument();
		// Compact token column, and the never-signed-in user says so.
		expect(screen.getByText("18.4M")).toBeInTheDocument();
		expect(screen.getByText("Never")).toBeInTheDocument();
	});

	it("sorts by a column header and flips direction on a second click", async () => {
		renderPane();

		const messagesHeader = screen.getByRole("button", { name: /^Messages/ });
		await fireEvent.click(messagesHeader);
		expect(rowNames()).toEqual(["levente", "kata", "julia"]);

		await fireEvent.click(messagesHeader);
		expect(rowNames()).toEqual(["julia", "kata", "levente"]);
	});

	it("keeps the selected user in the panel when a filter hides the row", async () => {
		renderPane();

		const search = screen.getByLabelText("Search by name or email");
		await fireEvent.input(search, { target: { value: "levente" } });

		expect(rowNames()).toEqual(["levente"]);
		const detail = screen.getByTestId("admin-user-detail");
		// Selection is explicit: hiding the row does not reassign it.
		expect(within(detail).getByText("Kata Bíró")).toBeInTheDocument();
		expect(
			within(detail).getByText(/hidden by the current filters/),
		).toBeInTheDocument();
	});

	it("shows the token hero with the completion/reasoning split", () => {
		renderPane();

		const detail = screen.getByTestId("admin-user-detail");
		expect(within(detail).getByText("3.9M")).toBeInTheDocument();
		expect(
			within(detail).getByText("2.7M completion · 1.2M reasoning"),
		).toBeInTheDocument();
		expect(within(detail).getByText("1,204")).toBeInTheDocument();
		expect(within(detail).getByText("96")).toBeInTheDocument();
	});

	it("asks for confirmation before granting admin access", async () => {
		const onPromoteUser = vi.fn();
		renderPane({ onPromoteUser });

		await fireEvent.click(
			screen.getByRole("button", { name: /Promote to Admin/ }),
		);
		expect(onPromoteUser).not.toHaveBeenCalled();

		expect(screen.getByText("Make Kata Bíró an admin?")).toBeInTheDocument();
		await fireEvent.click(screen.getByTestId("confirm-delete"));
		expect(onPromoteUser).toHaveBeenCalledWith("kata");
	});

	it("asks for confirmation before deleting a user", async () => {
		const onDeleteUser = vi.fn();
		renderPane({ onDeleteUser });

		await fireEvent.click(screen.getByRole("button", { name: /Delete User/ }));
		expect(onDeleteUser).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByTestId("confirm-delete"));
		expect(onDeleteUser).toHaveBeenCalledWith("kata");
	});

	it("revokes sessions straight from the metadata row", async () => {
		const onRevokeSessions = vi.fn();
		renderPane({ onRevokeSessions });

		await fireEvent.click(
			screen.getByRole("button", { name: /Revoke Sessions/ }),
		);
		expect(onRevokeSessions).toHaveBeenCalledWith("kata");
	});

	it("disables every action on your own account", () => {
		renderPane({ selectedUserId: "levente" });

		expect(
			screen.getByRole("button", { name: /Demote to User/ }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: /Delete User/ })).toBeDisabled();
		expect(
			screen.getByRole("button", { name: /Revoke Sessions/ }),
		).toBeDisabled();
	});

	it("paginates long lists and moves between pages", async () => {
		const many = Array.from({ length: 12 }, (_, index) =>
			user({
				id: `user-${index}`,
				name: `User ${String(index).padStart(2, "0")}`,
				lastActiveAt: NOW - index * 60_000,
			}),
		);
		renderPane({
			users: many,
			selectedUserId: "user-0",
			currentUserId: "user-0",
		});

		const perPage = screen.getByLabelText("Rows per page", { exact: false });
		await fireEvent.change(perPage, { target: { value: "10" } });

		expect(screen.getAllByTestId("admin-user-row")).toHaveLength(10);
		expect(screen.getByText("Showing 1–10 of 12")).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: /Next/ }));
		expect(screen.getAllByTestId("admin-user-row")).toHaveLength(2);
		expect(screen.getByText("Showing 11–12 of 12")).toBeInTheDocument();
	});
});
