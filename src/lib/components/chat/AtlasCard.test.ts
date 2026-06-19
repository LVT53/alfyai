import {
	act,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { AtlasAction, AtlasJobCard } from "$lib/types";
import AtlasCard from "./AtlasCard.svelte";

function atlasJobFixture(overrides: Partial<AtlasJobCard> = {}): AtlasJobCard {
	return {
		id: "atlas-job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "in-depth",
		title: "Atlas research",
		status: "running",
		stage: "curate",
		progress: { percent: 42, stage: "curate", details: { queries: [] } },
		sourceCounts: { local: 2, web: 8, accepted: 6, rejected: 4 },
		usage: {
			inputTokens: 1200,
			outputTokens: 800,
			totalTokens: 2000,
			costUsdMicros: 250000,
		},
		outputs: {
			fileProductionJobId: "file-job-1",
			htmlChatGeneratedFileId: "html-file-1",
			pdfChatGeneratedFileId: "pdf-file-1",
			markdownChatGeneratedFileId: "md-file-1",
		},
		error: null,
		createdAt: 1,
		updatedAt: 2,
		completedAt: null,
		...overrides,
	};
}

describe("AtlasCard", () => {
	it("renders running Atlas progress and emits cancel", async () => {
		const onCancel = vi.fn();
		render(AtlasCard, {
			job: atlasJobFixture(),
			onCancel,
		});

		expect(screen.getByTestId("atlas-card")).toHaveTextContent("ATLAS");
		expect(screen.queryByText("42%")).not.toBeInTheDocument();
		expect(screen.getByText("Weighing source quality")).toBeInTheDocument();
		expect(screen.queryByText("Curating sources")).not.toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: "Cancel Atlas" }));
		expect(onCancel).toHaveBeenCalledWith("atlas-job-1");
	});

	it("rotates active progress messages without showing profile metadata", async () => {
		vi.useFakeTimers();
		try {
			render(AtlasCard, {
				job: atlasJobFixture(),
			});

			expect(screen.getByText("Weighing source quality")).toBeInTheDocument();
			expect(screen.queryByText("Curating sources")).not.toBeInTheDocument();
			expect(screen.queryByText("In-Depth")).not.toBeInTheDocument();

			await act(() => {
				vi.advanceTimersByTime(4200);
			});

			expect(screen.getByText("Sorting signal from noise")).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders the prototype exploration SVG for queued Atlas jobs", () => {
		render(AtlasCard, {
			job: atlasJobFixture({
				status: "queued",
				stage: "queued",
				progress: { percent: 0, stage: "queued", details: { queries: [] } },
			}),
		});

		const svg = screen.getByTestId("atlas-exploration-svg");
		expect(svg).toHaveAttribute("viewBox", "0 0 56 56");
		expect(svg.querySelector(".orbit-group")).toBeTruthy();
	});

	it("shows decomposed research questions in the active progress card", () => {
		render(AtlasCard, {
			job: atlasJobFixture({
				stage: "search",
				progress: {
					percent: 25,
					stage: "search",
					details: {
						queries: [
							"enterprise search retrieval architecture",
							"hybrid search evaluation methods",
						],
					},
				},
			}),
		});

		const queryRegion = screen.getByLabelText("Atlas research questions");
		expect(queryRegion).toHaveTextContent("Researching");
		expect(queryRegion).toHaveTextContent(
			"enterprise search retrieval architecture",
		);
		expect(queryRegion).toHaveTextContent("hybrid search evaluation methods");
	});

	it("renders the output rendering stage instead of falling back to generic running copy", () => {
		render(AtlasCard, {
			job: atlasJobFixture({
				stage: "render",
				progress: { percent: 97, stage: "render", details: { queries: [] } },
			}),
		});

		expect(screen.getByText("Preparing report files")).toBeInTheDocument();
		expect(screen.queryByText("Rendering outputs")).not.toBeInTheDocument();
		expect(screen.queryByText("Running research")).not.toBeInTheDocument();
	});

	it("renders completed actions with Open as the only text button and grouped download options", async () => {
		const onOpenDocument = vi.fn();
		render(AtlasCard, {
			job: atlasJobFixture({ status: "succeeded", completedAt: 121 }),
			onOpenDocument,
		});

		await fireEvent.click(screen.getByRole("button", { name: "Open" }));

		expect(onOpenDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "html-file-1",
				source: "chat_generated_file",
				downloadUrl: "/api/chat/files/html-file-1/download",
			}),
		);

		expect(
			screen.queryByRole("link", { name: "Download PDF" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "Download Markdown" }),
		).not.toBeInTheDocument();
		await fireEvent.click(
			screen.getByRole("button", { name: "Download Atlas" }),
		);
		const downloadMenu = screen.getByRole("menu", {
			name: "Download Atlas",
		});
		expect(
			within(downloadMenu).getByRole("menuitem", { name: "Download HTML" }),
		).toHaveAttribute("href", "/api/chat/files/html-file-1/download");
		expect(
			within(downloadMenu).getByRole("menuitem", { name: "Download PDF" }),
		).toHaveAttribute("href", "/api/chat/files/pdf-file-1/download");
		expect(
			within(downloadMenu).getByRole("menuitem", {
				name: "Download Markdown",
			}),
		).toHaveAttribute("href", "/api/chat/files/md-file-1/download");
		expect(
			screen.getByRole("button", { name: "Continue Atlas" }),
		).toHaveTextContent("");
		expect(
			screen.getByRole("button", { name: "Fork Atlas" }),
		).toHaveTextContent("");
		expect(
			screen.getByRole("button", { name: "Revise Atlas" }),
		).toHaveTextContent("");
	});

	it.each([
		["continue", "Continue Atlas"] as const,
		["fork", "Fork Atlas"] as const,
		["revise", "Revise Atlas"] as const,
	])("opens an inline %s panel and emits the lifecycle action", async (action: AtlasAction, label: string) => {
		const onLifecycleAction = vi.fn();
		render(AtlasCard, {
			job: atlasJobFixture({ status: "succeeded", completedAt: 121 }),
			onLifecycleAction,
		});

		await fireEvent.click(screen.getByRole("button", { name: label }));
		const panel = screen.getByRole("region", { name: label });
		await fireEvent.input(within(panel).getByRole("textbox"), {
			target: { value: "Add source-quality detail" },
		});
		await fireEvent.click(within(panel).getByRole("button", { name: label }));

		expect(onLifecycleAction).toHaveBeenCalledWith({
			jobId: "atlas-job-1",
			action,
			message: "Add source-quality detail",
			profile: "in-depth",
		});
	});
});
