import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "$lib/client/api/http";
import type {
	MemoryDetail,
	MemoryOperation,
	MemoryPage,
} from "$lib/memory-types";
import { uiLanguage } from "$lib/stores/settings";
import KnowledgeMemoryView from "./KnowledgeMemoryView.svelte";

const api = vi.hoisted(() => ({
	fetchMemoryPage: vi.fn(),
	fetchMemoryDetail: vi.fn(),
	submitMemoryAction: vi.fn(),
	fetchMemoryOperation: vi.fn(),
	fetchMemoryOperationByRequest: vi.fn(),
}));
vi.mock("$lib/client/api/memory", () => api);
vi.mock("svelte/transition", () => ({
	fly: () => ({ duration: 0 }),
	slide: () => ({ duration: 0 }),
}));
const ref = {
	scope: { kind: "personal" },
	generation: "g1",
	rowId: "kayak",
} as const;
const row = {
	ref,
	text: "You own a green touring kayak and a white racing kayak.",
	updatedAt: "2026-11-18T09:00:00Z",
	sourceCount: 1,
};
const page: MemoryPage = {
	authority: "hindsight",
	scope: ref.scope,
	generation: "g1",
	rows: [row],
	nextCursor: null,
	total: 1,
	status: "ready",
};
const detail: MemoryDetail = {
	row,
	sources: [
		{
			id: "source",
			conversationId: "chat",
			messageId: "reply",
			title: "Kayak setup",
			quote: "My touring kayak is green. My racing kayak is white.",
			assertedAt: row.updatedAt,
			available: true,
		},
	],
	versions: [
		{ text: "A yellow touring kayak.", changedAt: "2026-11-16T09:00:00Z" },
	],
	canEdit: true,
	canRemove: true,
};
const failed: MemoryOperation = {
	id: "op",
	status: "failed",
	retryable: true,
	errorCode: "validation_failed",
	exclusionAcknowledged: false,
	cleanupPending: false,
	ref: null,
};
beforeEach(() => {
	vi.clearAllMocks();
	uiLanguage.set("en");
	api.fetchMemoryPage.mockReset().mockResolvedValue(page);
	api.fetchMemoryDetail.mockResolvedValue(detail);
	api.submitMemoryAction.mockResolvedValue(failed);
});
async function open() {
	render(KnowledgeMemoryView, { memoryEnabled: true });
	await fireEvent.click(
		await screen.findByRole("button", { name: /You own a green/ }),
	);
	await screen.findByTestId("memory-detail");
}
describe("published Memory UI", () => {
	it("opens provenance without changing original quotations and only shows verified prior wording", async () => {
		await open();
		expect(screen.getByRole("link", { name: "Kayak setup" })).toHaveAttribute(
			"href",
			"/chat/chat?focus_message=reply",
		);
		expect(screen.getByText(detail.sources[0].quote)).toBeVisible();
		await fireEvent.click(
			screen.getByRole("button", { name: /Previous versions/ }),
		);
		expect(screen.getByText("A yellow touring kayak.")).toBeVisible();
		expect(screen.getByText("No longer used")).toBeVisible();
	});
	it.each([
		"en",
		"hu",
	] as const)("omits an unverified memory date and displays the original source date in %s", async (language) => {
		uiLanguage.set(language);
		const undated = { ...row, updatedAt: null };
		api.fetchMemoryPage.mockResolvedValue({ ...page, rows: [undated] });
		api.fetchMemoryDetail.mockResolvedValue({ ...detail, row: undated });
		render(KnowledgeMemoryView, { memoryEnabled: true });
		const item = await screen.findByRole("button", { name: /You own a green/ });
		expect(item.querySelector("time")).toBeNull();
		await fireEvent.click(item);
		const panel = await screen.findByTestId("memory-detail");
		const [sourceDate] = panel.querySelectorAll("time");
		expect(panel.querySelectorAll("time")).toHaveLength(1);
		expect(sourceDate).toHaveAttribute(
			"datetime",
			detail.sources[0].assertedAt,
		);
		expect(sourceDate).toHaveTextContent(
			new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(
				new Date(detail.sources[0].assertedAt),
			),
		);
	});
	it.each([
		{
			language: "en",
			attribution: "Added by you",
			conversation: "Conversation",
		},
		{
			language: "hu",
			attribution: "Általad hozzáadva",
			conversation: "Beszélgetés",
		},
	] as const)("shows verified manual provenance in $language", async ({
		language,
		attribution,
		conversation,
	}) => {
		uiLanguage.set(language);
		api.fetchMemoryDetail.mockResolvedValue({
			...detail,
			origin: "manual",
			sources: [],
			versions: [],
		});
		await open();
		expect(screen.getByText(attribution)).toBeVisible();
		expect(
			screen.queryByRole("heading", { name: conversation }),
		).not.toBeInTheDocument();
	});
	it("omits the provenance card when origin is unknown and sources are empty", async () => {
		api.fetchMemoryDetail.mockResolvedValue({
			...detail,
			origin: "unknown",
			sources: [],
			versions: [],
		});
		await open();
		expect(
			screen.queryByRole("heading", { name: "Conversation" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Added by you")).not.toBeInTheDocument();
	});
	it("keeps partial-removal draft and original memory on failed verification; retry reuses intent", async () => {
		await open();
		await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		const input = screen.getByRole("textbox", { name: "Memory" });
		await fireEvent.input(input, {
			target: { value: "You own a touring kayak and a white racing kayak." },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByRole("alert");
		expect(input).toHaveValue(
			"You own a touring kayak and a white racing kayak.",
		);
		const request = api.submitMemoryAction.mock.calls[0][0];
		expect(request).toMatchObject({
			kind: "edit",
			ref,
			text: "You own a touring kayak and a white racing kayak.",
		});
		await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(api.submitMemoryAction.mock.calls[1][0]).toEqual(request);
	});
	it("does not claim removal before exclusion is acknowledged", async () => {
		await open();
		await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Alfy may still use it",
		);
		expect(screen.queryByText("Memory removed")).not.toBeInTheDocument();
	});
	it("dismissal does not clear acknowledged exclusion or enable removing again", async () => {
		api.submitMemoryAction.mockResolvedValue({
			...failed,
			exclusionAcknowledged: true,
			cleanupPending: true,
		});
		await open();
		await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		await screen.findByRole("alert");
		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
		expect(
			screen.getByText(
				"This memory is no longer used. Cleanup is still pending.",
			),
		).toBeVisible();
	});
	it("does not accept a stale edit without reviewing new accepted wording", async () => {
		api.submitMemoryAction.mockResolvedValue({
			...failed,
			status: "stale",
			retryable: false,
		});
		await open();
		await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByRole("button", { name: "Review latest version" });
		expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
	});
	it("keeps pending operations pending after feedback dismissal and disables second mutations", async () => {
		api.submitMemoryAction.mockResolvedValue({
			...failed,
			status: "working",
			retryable: false,
		});
		await open();
		await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByText("Your change is still being checked.");
		expect(
			screen.getByRole("button", { name: "Saving changes…" }),
		).toBeDisabled();
		expect(screen.queryByText("Memory saved")).not.toBeInTheDocument();
	});
	it("does not silently present legacy history as migrated", async () => {
		api.fetchMemoryPage.mockResolvedValue({
			...page,
			authority: "legacy",
			rows: [],
			total: 0,
		});
		render(KnowledgeMemoryView, { memoryEnabled: true });
		expect(
			await screen.findByText(
				"Your earlier memories haven’t been imported yet.",
			),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "Add memory" })).toBeDisabled();
	});
	it("keeps memory off controls in Profile and translates the new views", async () => {
		uiLanguage.set("hu");
		render(KnowledgeMemoryView, { memoryEnabled: false });
		expect(await screen.findByText("A memória ki van kapcsolva")).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Memória hozzáadása" }),
		).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: /Manage|Keep part|Correct/ }),
		).not.toBeInTheDocument();
		uiLanguage.set("en");
	});
	it.each([
		{ control: "Edit", action: "Save changes", panel: "memory-editor" },
		{ control: "Remove", action: "Remove", panel: "memory-remove" },
	])("disables the open $control action when a focus refresh reports Memory off", async ({
		control,
		action,
		panel,
	}) => {
		await open();
		await fireEvent.click(screen.getByRole("button", { name: control }));
		const submit = screen.getByRole("button", { name: action });
		expect(submit).toBeEnabled();
		api.fetchMemoryPage.mockResolvedValue({
			...page,
			status: "off",
			rows: [],
			total: 0,
		});

		await fireEvent.focus(window);

		expect(await screen.findByTestId("memory-off-notice")).toHaveTextContent(
			"Memory is off",
		);
		expect(submit).toBeDisabled();
		await fireEvent.click(submit);
		if (control === "Edit") await fireEvent.submit(screen.getByTestId(panel));
		expect(api.submitMemoryAction).not.toHaveBeenCalled();
		expect(screen.getByTestId(panel)).toBeVisible();
	});
	it("withdraws mutation Retry when Memory is turned off after a failed save", async () => {
		await open();
		await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		const retry = await screen.findByRole("button", { name: "Retry" });
		api.fetchMemoryPage.mockResolvedValue({
			...page,
			status: "off",
			rows: [],
			total: 0,
		});

		await fireEvent.focus(window);

		await screen.findByTestId("memory-off-notice");
		expect(retry).not.toBeInTheDocument();
		expect(api.submitMemoryAction).toHaveBeenCalledTimes(1);
	});
	it("ignores a late list result from a previous query", async () => {
		let resolve!: (value: MemoryPage) => void;
		api.fetchMemoryPage
			.mockImplementationOnce(() => new Promise((r) => (resolve = r)))
			.mockResolvedValueOnce({ ...page, rows: [], total: 0 });
		render(KnowledgeMemoryView, { memoryEnabled: true });
		await fireEvent.input(screen.getByRole("searchbox"), {
			target: { value: "not found" },
		});
		await waitFor(() => expect(api.fetchMemoryPage).toHaveBeenCalledTimes(2));
		resolve(page);
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: /You own a green/ }),
			).not.toBeInTheDocument(),
		);
	});
});

describe("review regressions: asynchronous navigation", () => {
	it("ignores a detail success after Add has opened", async () => {
		let resolve!: (v: MemoryDetail) => void;
		api.fetchMemoryDetail.mockImplementationOnce(
			() => new Promise((r) => (resolve = r)),
		);
		render(KnowledgeMemoryView, { memoryEnabled: true });
		await fireEvent.click(
			await screen.findByRole("button", { name: /You own a green/ }),
		);
		await fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "Keep my draft" },
		});
		resolve(detail);
		await waitFor(() =>
			expect(screen.getByRole("textbox")).toHaveValue("Keep my draft"),
		);
		expect(screen.queryByTestId("memory-detail")).not.toBeInTheDocument();
	});
	it("focuses Search after removal even while the old row is waiting for refresh", async () => {
		api.submitMemoryAction.mockResolvedValue({
			...failed,
			status: "applied",
			exclusionAcknowledged: true,
			retryable: false,
		});
		await open();
		let finishRefresh!: (updated: MemoryPage) => void;
		api.fetchMemoryPage.mockImplementationOnce(
			() => new Promise((resolve) => (finishRefresh = resolve)),
		);
		await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(screen.queryByTestId("memory-remove")).not.toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
		finishRefresh({ ...page, rows: [], total: 0 });
		await screen.findByText("Nothing remembered here yet");
		expect(screen.getByRole("searchbox")).toHaveFocus();
	});
	it("locks the uncertain submitted draft and retries its request identity", async () => {
		api.submitMemoryAction.mockRejectedValueOnce(
			new TypeError("connection lost"),
		);
		render(KnowledgeMemoryView, { memoryEnabled: true });
		await screen.findByRole("button", { name: /You own a green/ });
		await fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "Tea" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByRole("alert");
		expect(screen.getByRole("textbox")).toBeDisabled();
		const sent = api.submitMemoryAction.mock.calls[0][0];
		await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(api.submitMemoryAction.mock.calls[1][0]).toEqual(sent);
	});
	it("offers one Retry for the initial list error and shows an accepted empty result after retry", async () => {
		api.fetchMemoryPage
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ ...page, rows: [], total: 0 });
		render(KnowledgeMemoryView, { memoryEnabled: true });
		const alert = await screen.findByRole("alert");
		expect(
			screen.getAllByText("Couldn’t load memories. Please try again."),
		).toHaveLength(1);
		const retry = screen.getByRole("button", { name: "Retry" });
		expect(alert).toContainElement(retry);
		await fireEvent.click(retry);
		expect(
			await screen.findByText("Nothing remembered here yet"),
		).toBeVisible();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
	it("does not render accepted-empty after dismissing an initial list failure", async () => {
		api.fetchMemoryPage.mockRejectedValueOnce(new Error("offline"));
		render(KnowledgeMemoryView, { memoryEnabled: true });
		await screen.findByRole("alert");
		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(
			screen.queryByText("Nothing remembered here yet"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add memory" })).toBeDisabled();
	});
	it.each([
		{ scenario: "on a fresh visit", openedRecord: false },
		{ scenario: "after visiting a different memory", openedRecord: true },
	])("returns focus to Add after cancelling $scenario", async ({
		openedRecord,
	}) => {
		if (openedRecord) {
			await open();
			await fireEvent.click(
				screen.getByRole("button", { name: "Back to memories" }),
			);
			expect(
				screen.getByRole("button", { name: /You own a green/ }),
			).toHaveFocus();
		} else {
			render(KnowledgeMemoryView, { memoryEnabled: true });
			await screen.findByRole("button", { name: /You own a green/ });
		}
		const add = screen.getByRole("button", { name: "Add memory" });
		add.focus();
		await fireEvent.click(add);
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Add memory" })).toHaveFocus(),
		);
	});
	it("focuses Search on return when the last opened row is no longer listed", async () => {
		await open();
		api.fetchMemoryPage.mockResolvedValue({ ...page, rows: [], total: 0 });
		await fireEvent.focus(window);
		await fireEvent.click(
			screen.getByRole("button", { name: "Back to memories" }),
		);
		await screen.findByText("Nothing remembered here yet");
		await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
	});
});

describe("review regressions: recovery and attribution", () => {
	it("does not show inaccessible source quotations or invent manual authorship", async () => {
		api.fetchMemoryDetail.mockResolvedValue({
			...detail,
			sources: [
				{ ...detail.sources[0], available: false, quote: "SECRET WITHHELD" },
			],
		});
		await open();
		expect(screen.queryByText("SECRET WITHHELD")).not.toBeInTheDocument();
		expect(
			screen.getByText("This source is no longer available."),
		).toBeVisible();
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
		expect(screen.queryByText("Added by you")).not.toBeInTheDocument();
	});
	it("does not attach an old detail failure to a newer draft", async () => {
		let reject!: (e: Error) => void;
		api.fetchMemoryDetail.mockImplementationOnce(
			() => new Promise((_r, j) => (reject = j)),
		);
		render(KnowledgeMemoryView, { memoryEnabled: true });
		await fireEvent.click(
			await screen.findByRole("button", { name: /You own a green/ }),
		);
		await fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
		reject(new Error("old read failed"));
		await waitFor(() =>
			expect(screen.getByTestId("memory-editor")).toBeVisible(),
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
	it("recovers polling after its error is dismissed", async () => {
		api.submitMemoryAction.mockResolvedValue({ ...failed, status: "queued" });
		api.fetchMemoryOperation
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ ...failed, status: "applied", ref: null });
		await open();
		await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		await fireEvent.click(screen.getByRole("button", { name: "Check status" }));
		await screen.findByRole("alert");
		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		await fireEvent.click(screen.getByRole("button", { name: "Check status" }));
		expect(await screen.findByTestId("memory-list")).toBeVisible();
	});
	it("finds the same authorized row on page two when reviewing a stale edit", async () => {
		api.submitMemoryAction.mockResolvedValue({ ...failed, status: "stale" });
		await open();
		await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByRole("button", { name: "Review latest version" });
		api.fetchMemoryPage
			.mockResolvedValueOnce({
				...page,
				generation: "g2",
				rows: [],
				nextCursor: "page2",
			})
			.mockResolvedValueOnce({
				...page,
				generation: "g2",
				rows: [{ ...row, ref: { ...ref, generation: "g2" } }],
			});
		api.fetchMemoryDetail.mockResolvedValueOnce({
			...detail,
			row: {
				...row,
				text: "Latest wording",
				ref: { ...ref, generation: "g2" },
			},
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Review latest version" }),
		);
		expect(await screen.findByText("Latest wording")).toBeVisible();
		await fireEvent.click(
			screen.getByRole("button", { name: "Continue editing" }),
		);
		expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
		expect(api.fetchMemoryPage).toHaveBeenCalledWith({
			scope: ref.scope,
			cursor: "page2",
		});
	});
});

describe("second review regressions", () => {
	it("consumes applied edits once and does not reopen detail on focus", async () => {
		api.submitMemoryAction.mockResolvedValue({
			...failed,
			status: "applied",
			ref,
		});
		await open();
		await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByTestId("memory-detail");
		await fireEvent.click(
			screen.getByRole("button", { name: "Back to memories" }),
		);
		await fireEvent.focus(window);
		expect(api.fetchMemoryOperation).not.toHaveBeenCalled();
		expect(screen.getByTestId("memory-list")).toBeVisible();
	});
	it("focuses the explicit detail heading instead of Back", async () => {
		await open();
		await waitFor(() =>
			expect(screen.getByRole("heading", { name: "Memory" })).toHaveFocus(),
		);
	});
	it("clears cached scope immediately while restoring another scope", async () => {
		const view = render(KnowledgeMemoryView, { memoryEnabled: true });
		await screen.findByRole("button", { name: /You own a green/ });
		api.fetchMemoryPage.mockImplementationOnce(() => new Promise(() => {}));
		void view.component.restore({
			scopeValue: "project-b",
			query: "",
			pages: 1,
			rowId: "",
			scrollTop: 0,
			pending: null,
		});
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: /You own a green/ }),
			).not.toBeInTheDocument(),
		);
	});
});

it.each([
	401, 403, 404,
])("removes accepted quotations and rows on authorization loss %s", async (status) => {
	await open();
	api.fetchMemoryPage.mockRejectedValue(new ApiError("denied", { status }));
	api.fetchMemoryDetail.mockRejectedValue(new ApiError("denied", { status }));
	await fireEvent.focus(window);
	await waitFor(() =>
		expect(screen.queryByText(detail.sources[0].quote)).not.toBeInTheDocument(),
	);
	expect(
		screen.queryByRole("button", { name: /You own a green/ }),
	).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Add memory" })).toBeDisabled();
});
it("retains unresolved restored identity without blocking unrelated work or creating another mutation", async () => {
	api.fetchMemoryOperationByRequest.mockRejectedValue(
		new ApiError("unknown", { status: 404 }),
	);
	const view = render(KnowledgeMemoryView, { memoryEnabled: true });
	await screen.findByTestId("memory-list");
	await view.component.restore({
		scopeValue: "personal",
		query: "",
		pages: 1,
		rowId: "",
		scrollTop: 0,
		pending: {
			requestId: "lost",
			operationId: null,
			kind: "add",
			scope: { kind: "personal" },
			rowId: null,
		},
	});
	await waitFor(() =>
		expect(api.fetchMemoryOperationByRequest).toHaveBeenCalledWith("lost"),
	);
	expect(screen.getByRole("button", { name: "Add memory" })).toBeEnabled();
	await fireEvent.click(screen.getByRole("button", { name: "Check status" }));
	expect(view.component.capture().detached?.[0]?.requestId).toBe("lost");
	api.fetchMemoryOperationByRequest.mockResolvedValue({
		...failed,
		status: "applied",
	});
	await fireEvent.click(screen.getByRole("button", { name: "Check status" }));
	await waitFor(() => expect(view.component.capture().detached).toEqual([]));
	expect(api.submitMemoryAction).not.toHaveBeenCalled();
});

it("keeps reconciling background work after one scheduled transport failure", async () => {
	api.fetchMemoryPage
		.mockResolvedValueOnce({ ...page, status: "working" })
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue({ ...page, status: "ready" });
	render(KnowledgeMemoryView, { memoryEnabled: true });
	await screen.findByText(/Updating/);
	await waitFor(() => expect(api.fetchMemoryPage).toHaveBeenCalledTimes(3), {
		timeout: 8000,
	});
	await waitFor(() =>
		expect(screen.queryByText(/Updating/)).not.toBeInTheDocument(),
	);
}, 10000);
it("does not reopen an editor cancelled while its request is running", async () => {
	api.submitMemoryAction.mockResolvedValue({ ...failed, status: "queued" });
	api.fetchMemoryOperation.mockResolvedValue({
		...failed,
		status: "applied",
		ref,
	});
	await open();
	await fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
	await screen.findByRole("button", { name: "Check status" });
	await fireEvent.click(
		screen.getByRole("button", { name: "Back to memories" }),
	);
	await fireEvent.focus(window);
	await waitFor(() => expect(api.fetchMemoryOperation).toHaveBeenCalled());
	expect(screen.getByTestId("memory-list")).toBeVisible();
});
