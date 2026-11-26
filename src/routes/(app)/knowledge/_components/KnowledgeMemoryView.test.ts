// @vitest-environment jsdom
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
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
	fetchMemoryQuarantine: vi.fn(),
	saveMemoryQuarantine: vi.fn(),
	fetchMemoryDetail: vi.fn(),
	submitMemoryAction: vi.fn(),
	fetchMemoryOperation: vi.fn(),
	fetchMemoryOperationByRequest: vi.fn(),
	fetchMemorySubjectIndex: vi.fn(),
	fetchMemorySubject: vi.fn(),
	fetchMemoryOverview: vi.fn(),
	writeMemoryOverview: vi.fn(),
}));
vi.mock("$lib/client/api/memory", () => api);
vi.mock("svelte/transition", () => ({
	fade: () => ({ duration: 0 }),
	fly: () => ({ duration: 0 }),
	scale: () => ({ duration: 0 }),
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
	api.fetchMemoryQuarantine
		.mockReset()
		.mockResolvedValue({ status: "unavailable", candidates: [] });
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
	it.each(["en", "hu"] as const)(
		"omits an unverified memory date and displays the original source date in %s",
		async (language) => {
			uiLanguage.set(language);
			const undated = { ...row, updatedAt: null };
			api.fetchMemoryPage.mockResolvedValue({ ...page, rows: [undated] });
			api.fetchMemoryDetail.mockResolvedValue({ ...detail, row: undated });
			render(KnowledgeMemoryView, { memoryEnabled: true });
			const item = await screen.findByRole("button", {
				name: /You own a green/,
			});
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
		},
	);
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
	] as const)(
		"shows verified manual provenance in $language",
		async ({ language, attribution, conversation }) => {
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
		},
	);
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
	])(
		"disables the open $control action when a focus refresh reports Memory off",
		async ({ control, action, panel }) => {
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
		},
	);
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
	])(
		"returns focus to Add after cancelling $scenario",
		async ({ openedRecord }) => {
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
				expect(
					screen.getByRole("button", { name: "Add memory" }),
				).toHaveFocus(),
			);
		},
	);
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

it.each([401, 403, 404])(
	"removes accepted quotations and rows on authorization loss %s",
	async (status) => {
		await open();
		api.fetchMemoryPage.mockRejectedValue(new ApiError("denied", { status }));
		api.fetchMemoryDetail.mockRejectedValue(new ApiError("denied", { status }));
		await fireEvent.focus(window);
		await waitFor(() =>
			expect(
				screen.queryByText(detail.sources[0].quote),
			).not.toBeInTheDocument(),
		);
		expect(
			screen.queryByRole("button", { name: /You own a green/ }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add memory" })).toBeDisabled();
	},
);
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

it("offers private review in preparing authority while leaving ordinary Add unavailable", async () => {
	api.fetchMemoryPage.mockResolvedValue({
		...page,
		authority: "preparing",
		rows: [],
		total: 0,
	});
	api.fetchMemoryQuarantine.mockResolvedValue({
		status: "idle",
		candidates: [],
	});
	render(KnowledgeMemoryView, { memoryEnabled: true });
	expect(
		await screen.findByRole("button", { name: "Review earlier chats" }),
	).toBeEnabled();
	expect(
		await screen.findByRole("button", { name: "Add memory" }),
	).toBeDisabled();
	expect(api.saveMemoryQuarantine).not.toHaveBeenCalled();
});

// A link from Workspace Search opens one entry: the Memory tab with that entry's
// detail, or, when the entry has changed since, the scope's list with the
// search filled in. The scope, entry and query are read once, when the view
// mounts; `openLink` does the same for a view that is already showing.
describe("a link to one entry", () => {
	const personal = { kind: "personal" } as const;
	const fifty = Array.from({ length: 50 }, (_, index) => ({
		...row,
		ref: { ...ref, rowId: `other-${index}` },
		text: `Other entry ${index}`,
	}));

	it("opens the linked entry's detail", async () => {
		render(KnowledgeMemoryView, {
			memoryEnabled: true,
			initialScope: personal,
			initialEntryId: "kayak",
			initialQuery: "kayak",
		});

		expect(await screen.findByTestId("memory-detail")).toBeVisible();
		expect(api.fetchMemoryDetail).toHaveBeenCalledWith(ref, expect.anything());
		expect(screen.getByText(row.text)).toBeVisible();
	});

	it("finds a linked entry past the first fifty", async () => {
		api.fetchMemoryPage.mockImplementation(
			async (request: { cursor?: string }) =>
				request.cursor === "page2"
					? { ...page, rows: [row] }
					: { ...page, rows: fifty, nextCursor: "page2" },
		);

		render(KnowledgeMemoryView, {
			memoryEnabled: true,
			initialScope: personal,
			initialEntryId: "kayak",
			initialQuery: "kayak",
		});

		expect(await screen.findByTestId("memory-detail")).toBeVisible();
		expect(api.fetchMemoryPage).toHaveBeenCalledWith({
			scope: personal,
			cursor: "page2",
		});
		expect(api.fetchMemoryDetail).toHaveBeenCalledWith(ref, expect.anything());
	});

	it("falls back to the filled-in list when the entry has changed", async () => {
		api.fetchMemoryPage.mockImplementation(
			async (request: { query?: string }) =>
				request.query
					? { ...page, rows: [row] }
					: { ...page, rows: fifty.slice(0, 3) },
		);

		const { container } = render(KnowledgeMemoryView, {
			memoryEnabled: true,
			initialScope: personal,
			initialEntryId: "no-longer-there",
			initialQuery: "kayak",
		});

		// The list shows what the filled-in search finds, and no detail opens.
		expect(
			await screen.findByRole("button", { name: /You own a green/ }),
		).toBeVisible();
		expect(
			container.querySelector<HTMLInputElement>("[data-memory-search]")?.value,
		).toBe("kayak");
		expect(screen.queryByTestId("memory-detail")).toBeNull();
		expect(api.fetchMemoryDetail).not.toHaveBeenCalled();
		expect(api.fetchMemoryPage).toHaveBeenCalledWith(
			{ scope: personal, query: "kayak" },
			expect.anything(),
		);
	});

	it("shows the scope's list with no search for a link that names no entry", async () => {
		const { container } = render(KnowledgeMemoryView, {
			memoryEnabled: true,
			initialScope: personal,
			initialQuery: "kayak",
		});
		await screen.findByRole("button", { name: /You own a green/ });
		expect(
			container.querySelector<HTMLInputElement>("[data-memory-search]")?.value,
		).toBe("kayak");
		expect(api.fetchMemoryDetail).not.toHaveBeenCalled();
	});

	it("reads the linked project's bank, not the personal one", async () => {
		const project = { kind: "project", projectId: "p1" } as const;
		api.fetchMemoryPage.mockImplementation(
			async (request: { scope: unknown }) => ({
				...page,
				scope: request.scope,
				rows: [{ ...row, ref: { ...ref, scope: project } }],
			}),
		);
		render(KnowledgeMemoryView, {
			memoryEnabled: true,
			initialScope: project,
			initialEntryId: "kayak",
		});
		expect(await screen.findByTestId("memory-detail")).toBeVisible();
		expect(api.fetchMemoryDetail).toHaveBeenCalledWith(
			{ ...ref, scope: project },
			expect.anything(),
		);
		for (const [request] of api.fetchMemoryPage.mock.calls) {
			expect(request.scope).toEqual(project);
		}
	});

	it("goes back from the opened entry to the scope's whole list", async () => {
		const { container } = render(KnowledgeMemoryView, {
			memoryEnabled: true,
			initialScope: personal,
			initialEntryId: "kayak",
			initialQuery: "kayak",
		});
		await screen.findByTestId("memory-detail");
		await fireEvent.click(
			screen.getByRole("button", { name: "Back to memories" }),
		);
		expect(
			await screen.findByRole("button", { name: /You own a green/ }),
		).toBeVisible();
		expect(
			container.querySelector<HTMLInputElement>("[data-memory-search]")?.value,
		).toBe("");
	});

	it("opens another link in a view that is already showing", async () => {
		const view = render(KnowledgeMemoryView, { memoryEnabled: true });
		await screen.findByRole("button", { name: /You own a green/ });
		expect(api.fetchMemoryDetail).not.toHaveBeenCalled();

		await view.component.openLink({
			scope: personal,
			entryId: "kayak",
			query: "kayak",
		});

		expect(await screen.findByTestId("memory-detail")).toBeVisible();
		expect(api.fetchMemoryDetail).toHaveBeenCalledWith(ref, expect.anything());
	});
});

describe("the subject index (layout C)", () => {
	const index = {
		authority: "hindsight",
		scope: ref.scope,
		generation: "g1",
		status: "ready",
		subjects: [
			{
				subject: "about_you",
				count: 1,
				preview: "Speaks three languages.",
				active: false,
				earlierCount: 0,
				earlierPreview: [],
			},
			{
				subject: "projects",
				count: 1,
				preview: row.text,
				active: true,
				earlierCount: 1,
				earlierPreview: ["A trip that ended"],
			},
		],
		earlier: { count: 1, preview: ["A trip that ended"] },
		currentCount: 2,
	};
	const subjectPage = {
		scope: ref.scope,
		generation: "g1",
		subject: "projects",
		state: "current",
		entries: [
			{
				ref,
				text: row.text,
				subject: "projects",
				kind: "ongoing",
				timeState: "current",
				lastMentionedAt: new Date().toISOString(),
				quietWeeks: null,
				earlierStates: [
					{ text: "Owned a yellow kayak", saidAt: "2025-03-14T09:30:00.000Z" },
				],
			},
		],
		total: 1,
		nextCursor: null,
	};

	beforeEach(() => {
		api.fetchMemorySubjectIndex.mockReset().mockResolvedValue(index);
		api.fetchMemorySubject.mockReset().mockResolvedValue(subjectPage);
	});

	it("draws the index, opens a subject, and opens an entry's detail from it", async () => {
		render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
		const projects = await screen.findByRole("button", { name: /Projects/ });
		expect(projects.textContent).toContain("active");
		expect(screen.getByText("Overview of you")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /Earlier · 1/ }).textContent,
		).toContain("A trip that ended");
		await fireEvent.click(projects);
		const pane = await screen.findByTestId("memory-subject-pane");
		expect(api.fetchMemorySubject).toHaveBeenCalledWith(
			expect.objectContaining({ subject: "projects", state: "current" }),
			expect.anything(),
		);
		await waitFor(() =>
			expect(pane.textContent).toContain(
				"Earlier: Owned a yellow kayak · as of March 2025",
			),
		);
		expect(pane.textContent).toContain("Last mentioned today");
		expect(pane.textContent).toContain("Earlier in Projects · 1");
		await fireEvent.click(
			within(pane).getByRole("button", { name: /You own a green/ }),
		);
		await screen.findByTestId("memory-detail");
		expect(api.fetchMemoryDetail).toHaveBeenCalledWith(ref, expect.anything());
	});

	it("shows no date for an earlier state dated after now", async () => {
		api.fetchMemorySubject.mockResolvedValue({
			...subjectPage,
			entries: [
				{
					...subjectPage.entries[0],
					earlierStates: [
						{
							text: "Planned a trip to Rome",
							saidAt: "2099-03-01T09:00:00.000Z",
						},
					],
				},
			],
		});
		render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
		await fireEvent.click(
			await screen.findByRole("button", { name: /Projects/ }),
		);
		const pane = await screen.findByTestId("memory-subject-pane");
		await waitFor(() =>
			expect(pane.textContent).toContain("Earlier: Planned a trip to Rome"),
		);
		expect(pane.textContent).not.toContain("as of");
	});

	it("words an earlier state's date as when it stood, in Hungarian too", async () => {
		// English says "as of March 2025"; a bare date after "Korábban:" would read
		// as the day the state ended, so the Hungarian dates the state ("idején")
		// and says nothing of who said it or when it stopped.
		uiLanguage.set("hu");
		render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
		await fireEvent.click(
			await screen.findByRole("button", { name: /Projektek/ }),
		);
		const pane = await screen.findByTestId("memory-subject-pane");
		await waitFor(() =>
			expect(pane.textContent).toContain(
				"Korábban: Owned a yellow kayak · 2025. március idején",
			),
		);
		expect(pane.textContent).not.toMatch(/said|mondta|említve:? 2025/);
	});

	it("does not read the index again while a search is shown", async () => {
		render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
		await screen.findByRole("button", { name: /Projects/ });
		expect(api.fetchMemorySubjectIndex).toHaveBeenCalledTimes(1);
		await fireEvent.input(screen.getByRole("searchbox"), {
			target: { value: "kayak" },
		});
		await waitFor(() =>
			expect(api.fetchMemoryPage).toHaveBeenLastCalledWith(
				expect.objectContaining({ query: "kayak" }),
				expect.anything(),
			),
		);
		expect(api.fetchMemorySubjectIndex).toHaveBeenCalledTimes(1);
		await fireEvent.input(screen.getByRole("searchbox"), {
			target: { value: "" },
		});
		await waitFor(() =>
			expect(api.fetchMemorySubjectIndex).toHaveBeenCalledTimes(2),
		);
	});

	it("keeps today's list for an account whose labels are not verified", async () => {
		render(KnowledgeMemoryView, { memoryEnabled: true, layout: "list" });
		await screen.findByTestId("memory-list");
		expect(screen.queryByTestId("memory-subjects")).toBeNull();
		expect(api.fetchMemorySubjectIndex).not.toHaveBeenCalled();
	});

	describe("for a keyboard and a screen reader", () => {
		it("puts the search before Add in the DOM, as a computer draws them", async () => {
			render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
			const scope = await screen.findByRole("combobox");
			const search = screen.getByRole("searchbox");
			const add = screen.getByRole("button", { name: "Add memory" });
			const overview = screen.getByRole("button", { name: /Overview of you/ });
			const follows = (a: Element, b: Element) =>
				Boolean(
					a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
				);
			expect(follows(scope, search)).toBe(true);
			expect(follows(search, add)).toBe(true);
			expect(follows(add, overview)).toBe(true);
		});

		// A person who says the word they see must reach the control (WCAG 2.5.3):
		// its name holds the word that is drawn on it, whatever else it says. In
		// Hungarian a suffix can change the last vowel ("Memória", "Memóriához").
		const nameHoldsTheDrawnWord = (button: HTMLElement) =>
			(button.getAttribute("aria-label") ?? "")
				.toLowerCase()
				.includes((button.textContent ?? "").trim().toLowerCase());

		it.each([
			["en", "Add memory", "Back to Memory", "3 entries", "1 entry"],
			[
				"hu",
				"Memória hozzáadása",
				"Vissza a Memória oldalra",
				"3 bejegyzés",
				"1 bejegyzés",
			],
		] as const)(
			"names Add, the back link and a row's count in full (%s)",
			async (language, add, back, three, one) => {
				uiLanguage.set(language);
				api.fetchMemorySubjectIndex.mockResolvedValue({
					...index,
					subjects: [{ ...index.subjects[0], count: 3 }, index.subjects[1]],
				});
				render(KnowledgeMemoryView, {
					memoryEnabled: true,
					layout: "subjects",
				});
				const addButton = await screen.findByRole("button", { name: add });
				expect(nameHoldsTheDrawnWord(addButton)).toBe(true);
				const rows = document.querySelectorAll<HTMLElement>(
					".memory-subject-row",
				);
				const count = rows[0].querySelector(".memory-subject-count");
				// The number is what is drawn; what is read is the number and its unit.
				expect(count?.querySelector("[aria-hidden]")?.textContent).toBe("3");
				expect(count?.querySelector(".sr-only")?.textContent).toBe(three);
				expect(
					screen.getByRole("button", { name: new RegExp(three) }),
				).toBeTruthy();
				expect(
					screen.getByRole("button", { name: new RegExp(one) }),
				).toBeTruthy();
				await fireEvent.click(rows[1]);
				const backButton = await screen.findByRole("button", { name: back });
				expect(nameHoldsTheDrawnWord(backButton)).toBe(true);
			},
		);

		it("focuses the opened subject's heading after a removal, where a phone hides the search", async () => {
			api.submitMemoryAction.mockResolvedValue({
				...failed,
				status: "applied",
				exclusionAcknowledged: true,
				retryable: false,
			});
			render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
			await fireEvent.click(
				await screen.findByRole("button", { name: /Projects/ }),
			);
			const pane = await screen.findByTestId("memory-subject-pane");
			await fireEvent.click(
				within(pane).getByRole("button", { name: /You own a green/ }),
			);
			await screen.findByTestId("memory-detail");
			await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
			await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
			expect(screen.queryByTestId("memory-remove")).not.toBeInTheDocument();
			await waitFor(() =>
				expect(
					within(screen.getByTestId("memory-subject-pane")).getByRole(
						"heading",
						{ name: "Projects" },
					),
				).toHaveFocus(),
			);
			expect(screen.getByRole("searchbox")).not.toHaveFocus();
		});

		it("still focuses the search after a removal when no subject is open", async () => {
			api.submitMemoryAction.mockResolvedValue({
				...failed,
				status: "applied",
				exclusionAcknowledged: true,
				retryable: false,
			});
			api.fetchMemoryPage.mockResolvedValue({ ...page, status: "ready" });
			render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
			await fireEvent.input(await screen.findByRole("searchbox"), {
				target: { value: "kayak" },
			});
			await fireEvent.click(
				await screen.findByRole("button", { name: /You own a green/ }),
			);
			await screen.findByTestId("memory-detail");
			await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
			await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
			await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
		});
	});

	describe("a subject's Earlier fold", () => {
		const earlierPage = (
			generation: string,
			rowId: string,
			text: string,
			nextCursor: string | null,
		) => ({
			...subjectPage,
			generation,
			state: "earlier" as const,
			entries: [
				{
					...subjectPage.entries[0],
					ref: { ...ref, rowId },
					text,
					timeState: "earlier" as const,
					earlierStates: [],
				},
			],
			total: 2,
			nextCursor,
		});
		async function openFold() {
			render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
			await fireEvent.click(
				await screen.findByRole("button", { name: /Projects/ }),
			);
			const pane = await screen.findByTestId("memory-subject-pane");
			await fireEvent.click(
				await within(pane).findByRole("button", {
					name: /Earlier in Projects · 1/,
				}),
			);
			await within(pane).findByText("Earlier one.");
			return pane;
		}

		it("keeps the entries it shows when More meets a stale page, and reads them again on request", async () => {
			let moved = false;
			api.fetchMemorySubject.mockImplementation(
				async (options: { state: string; cursor?: string }) => {
					if (options.state === "current") return subjectPage;
					if (!moved && options.cursor === "more-1") {
						moved = true;
						throw new ApiError("stale_memory", { status: 409 });
					}
					if (moved)
						return options.cursor === "more-2"
							? earlierPage("g2", "b2", "Earlier two.", null)
							: earlierPage("g2", "a2", "Earlier one.", "more-2");
					return earlierPage("g1", "a1", "Earlier one.", "more-1");
				},
			);
			const pane = await openFold();
			await fireEvent.click(
				within(pane).getByRole("button", { name: "Show more" }),
			);
			// Memory moved on: what is shown stays, and Try again reads it anew.
			const retry = await within(pane).findByRole("button", {
				name: "Try again",
			});
			expect(within(pane).getByText("Earlier one.")).toBeTruthy();
			expect(
				within(pane).getByText("Couldn’t load memories. Please try again."),
			).toBeTruthy();
			expect(
				within(pane).queryByRole("button", { name: "Show more" }),
			).toBeNull();
			await fireEvent.click(retry);
			await within(pane).findByText("Earlier two.");
			expect(within(pane).getByText("Earlier one.")).toBeTruthy();
			expect(
				within(pane).queryByRole("button", { name: "Try again" }),
			).toBeNull();
			expect(within(pane).queryByText(/Couldn’t load memories/)).toBeNull();
		});

		it("still says so, with nothing to keep, when the first read fails", async () => {
			api.fetchMemorySubject.mockImplementation(
				async (options: { state: string }) => {
					if (options.state === "current") return subjectPage;
					throw new ApiError("down", { status: 503 });
				},
			);
			render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
			await fireEvent.click(
				await screen.findByRole("button", { name: /Projects/ }),
			);
			const pane = await screen.findByTestId("memory-subject-pane");
			await fireEvent.click(
				await within(pane).findByRole("button", {
					name: /Earlier in Projects · 1/,
				}),
			);
			expect(
				await within(pane).findByText(
					"Couldn’t load memories. Please try again.",
				),
			).toBeTruthy();
		});
	});

	describe("a refresh while a subject is open", () => {
		// Memory refreshes itself every three seconds while it updates (the
		// list's status is queued, working or failed) and when the window is
		// focused again; both run `load("refresh")`, which the focus event starts.
		const entryOf = (rowId: string, text: string) => ({
			...subjectPage.entries[0],
			ref: { ...ref, rowId },
			text,
			earlierStates: [],
		});
		const pagesAt = (generation: string, tag: string) => ({
			first: {
				...subjectPage,
				generation,
				entries: [entryOf(`a${tag}`, `First page entry ${tag}.`)],
				total: 2,
				nextCursor: `more-${tag}`,
			},
			second: {
				...subjectPage,
				generation,
				entries: [entryOf(`b${tag}`, `Second page entry ${tag}.`)],
				total: 2,
				nextCursor: null,
			},
		});
		const readsOf = (pages: ReturnType<typeof pagesAt>, tag: string) => ({
			index: { ...index, generation: pages.first.generation },
			subject: async (options: { cursor?: string }) => {
				if (options.cursor === `more-${tag}`) return pages.second;
				return pages.first;
			},
		});
		async function refreshNow() {
			const reads = api.fetchMemorySubjectIndex.mock.calls.length;
			window.dispatchEvent(new Event("focus"));
			await waitFor(() =>
				expect(api.fetchMemorySubjectIndex.mock.calls.length).toBe(reads + 1),
			);
			// What the refresh starts for the opened subject settles.
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		async function openWithTwoPages(subjectName: RegExp) {
			render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
			await fireEvent.click(
				await screen.findByRole("button", { name: subjectName }),
			);
			await screen.findByText("First page entry g1.");
			await fireEvent.click(
				await screen.findByRole("button", { name: "Show more" }),
			);
			await screen.findByText("Second page entry g1.");
		}
		beforeEach(() => {
			api.fetchMemoryPage
				.mockReset()
				.mockResolvedValue({ ...page, status: "queued" });
			const reads = readsOf(pagesAt("g1", "g1"), "g1");
			api.fetchMemorySubjectIndex.mockReset().mockResolvedValue(reads.index);
			api.fetchMemorySubject.mockReset().mockImplementation(reads.subject);
		});

		it.each([
			["a subject", /Projects/],
			["the Earlier list", /Earlier · 1/],
		])(
			"keeps both pages of %s when Memory is unchanged",
			async (_name, row) => {
				await openWithTwoPages(row);
				const reads = api.fetchMemorySubject.mock.calls.length;
				await refreshNow();
				expect(screen.getByText("First page entry g1.")).toBeTruthy();
				expect(screen.getByText("Second page entry g1.")).toBeTruthy();
				expect(api.fetchMemorySubject.mock.calls.length).toBe(reads);
			},
		);

		it("never cuts off a More the person asked for", async () => {
			render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
			const pages = pagesAt("g1", "g1");
			let land: () => void = () => {};
			api.fetchMemorySubject.mockImplementation(
				(options: { cursor?: string }) =>
					options.cursor
						? new Promise((resolve) => {
								land = () => resolve(pages.second);
							})
						: Promise.resolve(pages.first),
			);
			await fireEvent.click(
				await screen.findByRole("button", { name: /Projects/ }),
			);
			await screen.findByText("First page entry g1.");
			await fireEvent.click(
				await screen.findByRole("button", { name: "Show more" }),
			);
			await refreshNow();
			land();
			expect(await screen.findByText("Second page entry g1.")).toBeTruthy();
			expect(screen.getByText("First page entry g1.")).toBeTruthy();
		});

		it("reads as many pages again when Memory changed under them", async () => {
			await openWithTwoPages(/Projects/);
			const next = readsOf(pagesAt("g2", "g2"), "g2");
			api.fetchMemorySubjectIndex.mockResolvedValue(next.index);
			api.fetchMemorySubject.mockImplementation(next.subject);
			await refreshNow();
			await screen.findByText("Second page entry g2.");
			expect(screen.getByText("First page entry g2.")).toBeTruthy();
			expect(screen.queryByText("First page entry g1.")).toBeNull();
		});

		it("answers a More past a change with the page it asked for, and the ones it had", async () => {
			render(KnowledgeMemoryView, { memoryEnabled: true, layout: "subjects" });
			await fireEvent.click(
				await screen.findByRole("button", { name: /Projects/ }),
			);
			await screen.findByText("First page entry g1.");
			const next = pagesAt("g2", "g2");
			api.fetchMemorySubject.mockImplementation(
				async (options: { cursor?: string }) => {
					if (options.cursor === "more-g1")
						throw new ApiError("stale_memory", { status: 409 });
					return options.cursor === "more-g2" ? next.second : next.first;
				},
			);
			await fireEvent.click(
				await screen.findByRole("button", { name: "Show more" }),
			);
			await screen.findByText("Second page entry g2.");
			expect(screen.getByText("First page entry g2.")).toBeTruthy();
		});
	});
});
