import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ImportChatGPTModal from "./ImportChatGPTModal.svelte";

const mockConversations = [
	{
		title: "Chat One",
		create_time: 1700000000,
		update_time: 1700000100,
		mapping: {
			"msg-1": { message: { id: "msg-1" }, parent: null, children: ["msg-2"] },
			"msg-2": { message: { id: "msg-2" }, parent: "msg-1", children: [] },
		},
	},
	{
		title: "Chat Two",
		create_time: 1700001000,
		update_time: 1700001100,
		mapping: {
			"msg-3": { message: { id: "msg-3" }, parent: null, children: [] },
		},
	},
];

vi.mock("jszip", () => {
	return {
		default: {
			loadAsync: vi.fn().mockResolvedValue({
				file: (name) =>
					name === "conversations.json"
						? {
								async: () => Promise.resolve(JSON.stringify(mockConversations)),
							}
						: null,
			}),
		},
	};
});

vi.mock("$lib/client/api/chatgpt-import", () => ({
	importChatGPTData: vi.fn().mockResolvedValue({
		jobId: "job-123",
		conversationIds: ["conv-1", "conv-2"],
		errors: [],
	}),
}));

function createZipFile(name = "export.zip"): File {
	return new File(["fake-zip-content"], name, { type: "application/zip" });
}

describe("ImportChatGPTModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders upload state when show is true", () => {
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		expect(
			screen.getByText("Import ChatGPT Conversations"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Upload a ChatGPT export ZIP to import your conversations.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Select ZIP file" }),
		).toBeInTheDocument();
	});

	it("does not render when show is false", () => {
		const { container } = render(ImportChatGPTModal, {
			props: { show: false, onClose: vi.fn(), projects: [] },
		});

		expect(container.querySelector("[role='dialog']")).not.toBeInTheDocument();
	});

	it("calls onClose when cancel is clicked", async () => {
		const onClose = vi.fn();
		render(ImportChatGPTModal, {
			props: { show: true, onClose, projects: [] },
		});

		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("transitions to preview after selecting a valid ZIP file", async () => {
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });

		const file = createZipFile();
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [file] },
		});

		await waitFor(() => {
			expect(
				screen.getByText("Select Conversations to Import"),
			).toBeInTheDocument();
		});

		expect(screen.getByText("Chat One")).toBeInTheDocument();
		expect(screen.getByText("Chat Two")).toBeInTheDocument();
	});

	it("filters conversations by search query", async () => {
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [createZipFile()] },
		});

		await waitFor(() => {
			expect(screen.getByText("Chat One")).toBeInTheDocument();
		});

		const searchInput = screen.getByPlaceholderText("Search conversations...");
		await fireEvent.input(searchInput, { target: { value: "Two" } });

		expect(screen.queryByText("Chat One")).not.toBeInTheDocument();
		expect(screen.getByText("Chat Two")).toBeInTheDocument();
	});

	it("toggles select all / deselect all", async () => {
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [createZipFile()] },
		});

		await waitFor(() => {
			expect(screen.getByText("Chat One")).toBeInTheDocument();
		});

		const selectAllBtn = screen.getByRole("button", { name: "Deselect all" });
		await fireEvent.click(selectAllBtn);

		const checkboxes = screen.getAllByRole("checkbox");
		expect(checkboxes.every((cb) => !(cb as HTMLInputElement).checked)).toBe(
			true,
		);

		await fireEvent.click(screen.getByRole("button", { name: "Select all" }));
		expect(checkboxes.every((cb) => (cb as HTMLInputElement).checked)).toBe(
			true,
		);
	});

	it("transitions to config state on next click", async () => {
		render(ImportChatGPTModal, {
			props: {
				show: true,
				onClose: vi.fn(),
				projects: [
					{
						id: "proj-1",
						name: "My Project",
						sortOrder: 0,
						createdAt: 1,
						updatedAt: 2,
					},
				],
			},
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [createZipFile()] },
		});

		await waitFor(() => {
			expect(
				screen.getByText("Select Conversations to Import"),
			).toBeInTheDocument();
		});

		await fireEvent.click(screen.getByRole("button", { name: "Next" }));

		await waitFor(() => {
			expect(screen.getByText("Import Settings")).toBeInTheDocument();
		});

		expect(screen.getByLabelText("Project folder")).toBeInTheDocument();
		expect(screen.getByText("My Project")).toBeInTheDocument();
	});

	it("shows error for non-zip files", async () => {
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });
		const txtFile = new File(["text"], "notes.txt", { type: "text/plain" });
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [txtFile] },
		});

		await waitFor(() => {
			expect(
				screen.getByText("Please select a valid ZIP file."),
			).toBeInTheDocument();
		});
	});

	it("resets state when modal is closed and reopened", async () => {
		const { rerender } = render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [createZipFile()] },
		});

		await waitFor(() => {
			expect(
				screen.getByText("Select Conversations to Import"),
			).toBeInTheDocument();
		});

		rerender({ show: false, onClose: vi.fn(), projects: [] });
		rerender({ show: true, onClose: vi.fn(), projects: [] });

		await waitFor(() => {
			expect(
				screen.getByText("Import ChatGPT Conversations"),
			).toBeInTheDocument();
		});
	});
});
