import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importChatGPTData } from "$lib/client/api/chatgpt-import";
import { ApiError } from "$lib/client/api/http";
import { uiLanguage } from "$lib/stores/settings";
import ImportChatGPTModal from "./ImportChatGPTModal.svelte";

// A real export names each conversation twice, `conversation_id` and `id`. The
// first has both; the second only `id`, which the server falls back to.
const mockConversations: Record<string, unknown>[] = [
	{
		title: "Chat One",
		conversation_id: "conv-1",
		id: "internal-1",
		create_time: 1700000000,
		update_time: 1700000100,
		mapping: {
			"msg-1": { message: { id: "msg-1" }, parent: null, children: ["msg-2"] },
			"msg-2": { message: { id: "msg-2" }, parent: "msg-1", children: [] },
		},
	},
	{
		title: "Chat Two",
		id: "conv-2",
		create_time: 1700001000,
		update_time: 1700001100,
		mapping: {
			"msg-3": { message: { id: "msg-3" }, parent: null, children: [] },
		},
	},
];

// What the mocked ZIP holds; a test that needs another export assigns it.
let exportedConversations: Record<string, unknown>[] = mockConversations;

vi.mock("jszip", () => {
	return {
		default: {
			loadAsync: vi.fn().mockResolvedValue({
				file: (name: string) =>
					name === "conversations.json"
						? {
								async: () =>
									Promise.resolve(JSON.stringify(exportedConversations)),
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
		exportedConversations = mockConversations;
		uiLanguage.set("en");
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
						hasInstructions: false,
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

	it("says in the reader's words that an import is already running", async () => {
		vi.mocked(importChatGPTData).mockRejectedValueOnce(
			new ApiError(
				"A ChatGPT import is already running for this account. Wait for it to finish, then try again.",
				{ status: 409, errorKey: "chatgptImport.alreadyRunning" },
			),
		);
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		await fireEvent.drop(
			screen.getByRole("button", { name: "Drop ZIP file here" }),
			{ dataTransfer: { files: [createZipFile()] } },
		);
		await fireEvent.click(await screen.findByRole("button", { name: "Next" }));
		await fireEvent.click(
			await screen.findByRole("button", { name: "Import 2 selected" }),
		);

		expect(
			await screen.findByText(
				"An import is already running. Wait for it to finish, then try again.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/already running for this account/),
		).not.toBeInTheDocument();
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
	describe("which conversations it imports", () => {
		async function openPreview(
			props: { projects?: unknown[]; dropLabel?: string } = {},
		) {
			render(ImportChatGPTModal, {
				props: {
					show: true,
					onClose: vi.fn(),
					projects: (props.projects ?? []) as never[],
				},
			});
			await fireEvent.drop(
				screen.getByRole("button", {
					name: props.dropLabel ?? "Drop ZIP file here",
				}),
				{ dataTransfer: { files: [createZipFile()] } },
			);
			await screen.findByText("Chat One");
		}

		const aProject = {
			id: "proj-1",
			name: "My Project",
			sortOrder: 0,
			hasInstructions: false,
			createdAt: 1,
			updatedAt: 2,
		};

		it("sends the conversations that are ticked, named as the export names them", async () => {
			await openPreview();

			await fireEvent.click(screen.getByRole("button", { name: "Next" }));
			await fireEvent.click(
				await screen.findByRole("button", { name: "Import 2 selected" }),
			);

			await waitFor(() => expect(importChatGPTData).toHaveBeenCalledTimes(1));
			// conversation_id where the export has one, else its id.
			expect(importChatGPTData).toHaveBeenCalledWith(
				expect.any(File),
				["conv-1", "conv-2"],
				null,
			);
		});

		it("leaves out the conversation that was unticked", async () => {
			await openPreview();

			await fireEvent.click(screen.getByLabelText(/Chat Two/));
			await fireEvent.click(screen.getByRole("button", { name: "Next" }));
			await fireEvent.click(
				await screen.findByRole("button", { name: "Import 1 selected" }),
			);

			await waitFor(() => expect(importChatGPTData).toHaveBeenCalledTimes(1));
			expect(importChatGPTData).toHaveBeenCalledWith(
				expect.any(File),
				["conv-1"],
				null,
			);
		});

		it("keeps an unticked conversation out even when a search hides it", async () => {
			await openPreview();

			await fireEvent.click(screen.getByLabelText(/Chat One/));
			await fireEvent.input(
				screen.getByPlaceholderText("Search conversations..."),
				{
					target: { value: "Two" },
				},
			);
			await fireEvent.click(screen.getByRole("button", { name: "Next" }));
			await fireEvent.click(
				await screen.findByRole("button", { name: "Import 1 selected" }),
			);

			await waitFor(() => expect(importChatGPTData).toHaveBeenCalledTimes(1));
			expect(importChatGPTData).toHaveBeenCalledWith(
				expect.any(File),
				["conv-2"],
				null,
			);
		});

		it("sends the project it was given along with the selection", async () => {
			await openPreview({ projects: [aProject] });

			await fireEvent.click(screen.getByRole("button", { name: "Next" }));
			await fireEvent.change(await screen.findByLabelText("Project folder"), {
				target: { value: "proj-1" },
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Import 2 selected" }),
			);

			await waitFor(() => expect(importChatGPTData).toHaveBeenCalledTimes(1));
			expect(importChatGPTData).toHaveBeenCalledWith(
				expect.any(File),
				["conv-1", "conv-2"],
				"proj-1",
			);
		});

		it("cannot go on, or import, while nothing is ticked", async () => {
			await openPreview();

			await fireEvent.click(
				screen.getByRole("button", { name: "Deselect all" }),
			);

			expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
			expect(importChatGPTData).not.toHaveBeenCalled();
		});

		it("leaves a conversation out of the list when the export gives it no id", async () => {
			exportedConversations = [
				...mockConversations,
				{
					title: "Nameless",
					create_time: 1700002000,
					update_time: 1700002100,
					mapping: {
						"msg-9": { message: { id: "msg-9" }, parent: null, children: [] },
					},
				},
			];

			await openPreview();

			expect(screen.queryByText("Nameless")).not.toBeInTheDocument();
			expect(screen.getByText(/conversations found/)).toHaveTextContent(
				"2 conversations found",
			);
		});
	});

	describe("what it says", () => {
		async function reachTheConfigStep(labels: { drop: string; next: string }) {
			render(ImportChatGPTModal, {
				props: { show: true, onClose: vi.fn(), projects: [] },
			});
			await fireEvent.drop(screen.getByRole("button", { name: labels.drop }), {
				dataTransfer: { files: [createZipFile()] },
			});
			await screen.findByText("Chat One");
			await fireEvent.click(screen.getByRole("button", { name: labels.next }));
		}

		const english = { drop: "Drop ZIP file here", next: "Next" };
		const hungarian = { drop: "Ejtse ide a ZIP fájlt", next: "Tovább" };

		it("counts what was found and what is ticked in the preview", async () => {
			render(ImportChatGPTModal, {
				props: { show: true, onClose: vi.fn(), projects: [] },
			});
			await fireEvent.drop(screen.getByRole("button", { name: english.drop }), {
				dataTransfer: { files: [createZipFile()] },
			});
			await screen.findByText("Chat One");

			const line = screen.getByText(/conversations found/);
			expect(line).toHaveTextContent("2 conversations found · 2 selected");

			await fireEvent.click(screen.getByLabelText(/Chat Two/));
			expect(line).toHaveTextContent("2 conversations found · 1 selected");
		});

		it("says how many conversations will be imported on the configuration step", async () => {
			await reachTheConfigStep(english);

			expect(
				await screen.findByText("2 conversations will be imported"),
			).toBeInTheDocument();
			expect(
				screen.queryByText(/messages conversations/),
			).not.toBeInTheDocument();
		});

		it("says 'conversation' for one", async () => {
			exportedConversations = [mockConversations[0]];
			vi.mocked(importChatGPTData).mockResolvedValueOnce({
				jobId: "job-1",
				conversationIds: ["conv-1"],
				errors: [],
			});
			await reachTheConfigStep(english);

			expect(
				await screen.findByText("1 conversation will be imported"),
			).toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: "Import 1 selected" }),
			);

			expect(
				await screen.findByText("1 conversation imported successfully."),
			).toBeInTheDocument();
		});

		it("says how many conversations were imported, and how many errors there were", async () => {
			vi.mocked(importChatGPTData).mockResolvedValueOnce({
				jobId: "job-1",
				conversationIds: ["conv-1", "conv-2"],
				errors: [{ reason: "a" }, { reason: "b" }],
			});
			await reachTheConfigStep(english);

			await fireEvent.click(
				await screen.findByRole("button", { name: "Import 2 selected" }),
			);

			expect(
				await screen.findByText("2 conversations imported successfully."),
			).toBeInTheDocument();
			expect(screen.getByText("2 errors occurred.")).toBeInTheDocument();
		});

		it("says all of it in Hungarian for a Hungarian reader", async () => {
			uiLanguage.set("hu");
			vi.mocked(importChatGPTData).mockResolvedValueOnce({
				jobId: "job-1",
				conversationIds: ["conv-1", "conv-2"],
				errors: [{ reason: "a" }],
			});
			render(ImportChatGPTModal, {
				props: { show: true, onClose: vi.fn(), projects: [] },
			});
			await fireEvent.drop(
				screen.getByRole("button", { name: hungarian.drop }),
				{ dataTransfer: { files: [createZipFile()] } },
			);
			await screen.findByText("Chat One");

			expect(screen.getByText(/beszélgetés található/)).toHaveTextContent(
				"2 beszélgetés található · 2 kijelölve",
			);

			await fireEvent.click(
				screen.getByRole("button", { name: hungarian.next }),
			);
			expect(
				await screen.findByText("2 beszélgetés lesz importálva"),
			).toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: "2 kijelölt importálása" }),
			);
			expect(
				await screen.findByText("2 beszélgetés sikeresen importálva."),
			).toBeInTheDocument();
			expect(screen.getByText("1 hiba történt.")).toBeInTheDocument();
		});
	});
});
