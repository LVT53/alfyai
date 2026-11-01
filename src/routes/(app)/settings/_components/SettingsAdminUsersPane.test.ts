import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
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
		twoStepEnabled: false,
		twoStepSince: null,
		backupCodesLeft: 0,
		explicitPictureFilterExempt: false,
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
			onSetExplicitPictureFilterExempt: vi.fn(),
			adminHasTwoStep: false,
			onResetTwoStep: vi.fn().mockResolvedValue(undefined),
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

	it("shows the explicit-picture filter as on and exempts the person from the detail row", async () => {
		const onSetExplicitPictureFilterExempt = vi.fn();
		renderPane({ onSetExplicitPictureFilterExempt });

		expect(
			screen.getByTestId("admin-user-picture-filter").textContent,
		).toContain("On");
		await fireEvent.click(screen.getByRole("button", { name: "Exempt" }));
		expect(onSetExplicitPictureFilterExempt).toHaveBeenCalledWith("kata", true);
	});

	it("turns the filter back on for an exempt person, the admin's own account included", async () => {
		const onSetExplicitPictureFilterExempt = vi.fn();
		renderPane({
			onSetExplicitPictureFilterExempt,
			selectedUserId: "levente",
			users: users.map((person) =>
				person.id === "levente"
					? { ...person, explicitPictureFilterExempt: true }
					: person,
			),
		});

		expect(
			screen.getByTestId("admin-user-picture-filter").textContent,
		).toContain("Exempt");
		await fireEvent.click(screen.getByRole("button", { name: "Filter again" }));
		expect(onSetExplicitPictureFilterExempt).toHaveBeenCalledWith(
			"levente",
			false,
		);
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

describe("SettingsAdminUsersPane — two-step sign-in", () => {
	const withTwoStep = (id: string, since: number, left: number) =>
		user({
			id,
			name: id === "kata" ? "Kata Bíró" : "Levente Alf",
			twoStepEnabled: true,
			twoStepSince: since,
			backupCodesLeft: left,
		});

	it("shows a quiet On or Off in the table's two-step column", () => {
		const since = Date.UTC(2026, 9, 2);
		renderPane({
			users: [withTwoStep("kata", since, 6), user({ id: "julia" })],
			selectedUserId: "kata",
		});

		const rowFor = (id: string) =>
			screen
				.getAllByTestId("admin-user-row")
				.find((row) => row.getAttribute("data-user-id") === id);
		const kata = rowFor("kata");
		const julia = rowFor("julia");
		if (!kata || !julia) throw new Error("expected both rows");
		expect(within(kata).getByTestId("admin-user-two-step")).toHaveTextContent(
			"On",
		);
		expect(within(julia).getByTestId("admin-user-two-step")).toHaveTextContent(
			"Off",
		);
	});

	it("names the detail row's since date and codes left", () => {
		const since = Date.UTC(2026, 9, 2);
		renderPane({
			users: [withTwoStep("kata", since, 6)],
			selectedUserId: "kata",
		});

		const detail = screen.getByTestId("admin-user-detail");
		expect(
			within(detail).getByText(/On since .*2026.*6 backup codes left/),
		).toBeInTheDocument();
	});

	it("offers the reset only when it is on, and never on the admin's own account", async () => {
		const since = Date.UTC(2026, 9, 2);
		renderPane({
			users: [withTwoStep("kata", since, 6)],
			selectedUserId: "kata",
		});
		expect(
			screen.getByRole("button", { name: /Reset two-step sign-in/ }),
		).toBeInTheDocument();

		cleanup();
		renderPane({
			currentUserId: "levente",
			users: [withTwoStep("levente", since, 6), withTwoStep("kata", since, 6)],
			selectedUserId: "levente",
		});
		expect(
			screen.queryByRole("button", { name: /Reset two-step sign-in/ }),
		).not.toBeInTheDocument();
	});

	it("opens the reset dialog with the person's name", async () => {
		const since = Date.UTC(2026, 9, 2);
		renderPane({
			users: [withTwoStep("kata", since, 6)],
			selectedUserId: "kata",
		});

		await fireEvent.click(
			screen.getByRole("button", { name: /Reset two-step sign-in/ }),
		);

		expect(
			screen.getByText("Reset Kata Bíró's two-step sign-in?"),
		).toBeInTheDocument();
	});
});
