import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import { uiLanguage } from "$lib/stores/settings";
import ArtifactCard, { type ArtifactCardView } from "./ArtifactCard.svelte";

function makeJob(
	overrides: Partial<FileProductionJob> = {},
): FileProductionJob {
	return {
		id: "job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		title: "Quarterly report",
		status: "queued",
		stage: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		files: [],
		warnings: [],
		dismissed: false,
		error: null,
		sourceMode: null,
		...overrides,
	};
}

function view(overrides: Partial<ArtifactCardView> = {}): ArtifactCardView {
	return {
		id: "artifact-1",
		kind: "document",
		title: "Weekend checklist",
		...overrides,
	};
}

describe("ArtifactCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
	});

	it("chrome=full renders the icon, title, kind label and Open", () => {
		const onOpen = vi.fn();
		render(ArtifactCard, {
			view: view({ openTargetId: "artifact-1" }),
			onOpen,
		});

		expect(screen.getByTestId("artifact-card")).toBeInTheDocument();
		expect(screen.getByText("Weekend checklist")).toBeInTheDocument();
		expect(screen.getByText("Document")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
	});

	it("chrome=body renders no title of its own, leaving exactly one in the composed row", async () => {
		const job = makeJob({ status: "running" });
		const { container } = render(ArtifactCard, {
			view: view({ kind: "file", title: "Quarterly report" }),
			job,
			chrome: "body",
		});

		// FileProductionCard's body has loaded (the running status line proves
		// it), and the row's own title text never appears inside the body: the
		// composed row would carry exactly one title, the host's.
		await screen.findByText("Generating files in the background.");
		expect(container.textContent).not.toContain("Quarterly report");
		expect(screen.queryByTestId("artifact-card")).not.toBeInTheDocument();
	});

	it("renders no Open affordance when openTargetId is null, and calls onOpen with it otherwise", async () => {
		const onOpen = vi.fn();
		const { rerender } = render(ArtifactCard, {
			view: view({ openTargetId: null }),
			onOpen,
		});
		expect(
			screen.queryByRole("button", { name: "Open" }),
		).not.toBeInTheDocument();

		await rerender({ view: view({ openTargetId: "artifact-1" }), onOpen });
		await fireEvent.click(screen.getByRole("button", { name: "Open" }));
		expect(onOpen).toHaveBeenCalledWith("artifact-1");
	});

	it("renders the File kind's running, failed and stale job states through the lazily-loaded body", async () => {
		const onRetry = vi.fn();
		const created = 1_700_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(created + 75_000);
		try {
			const { rerender } = render(ArtifactCard, {
				view: view({ kind: "file" }),
				job: makeJob({ status: "running", createdAt: created }),
				chrome: "body",
			});
			// The File body loads through a dynamic import() (one microtask);
			// findBy*'s setTimeout-based polling would fight the fake clock, so
			// the wait advances fake time instead, letting the real microtask
			// queue (the import) drain alongside it.
			await vi.advanceTimersByTimeAsync(0);
			expect(
				screen.getByText("Generating files in the background."),
			).toBeInTheDocument();
			expect(screen.getByText("1:15")).toBeInTheDocument();

			await rerender({
				view: view({ kind: "file" }),
				job: makeJob({
					status: "failed",
					createdAt: created,
					error: {
						code: "renderer_timeout",
						message: "Renderer timed out",
						retryable: true,
					},
				}),
				chrome: "body",
				onRetry,
			});
			await vi.advanceTimersByTimeAsync(0);
			const retryButton = screen.getByRole("button", { name: "Retry" });
			await fireEvent.click(retryButton);
			expect(onRetry).toHaveBeenCalledWith("job-1");
		} finally {
			vi.useRealTimers();
		}
	});

	// T9.4: the Document's "Document · 3 tabs" line, a generic optional slot
	// so every other kind (which never sets `subtitle`) is unaffected.
	it("renders the subtitle under the title when one is given", () => {
		render(ArtifactCard, {
			view: view({ subtitle: "Document · 3 tabs" }),
		});
		expect(screen.getByText("Document · 3 tabs")).toBeInTheDocument();
	});

	it("renders no subtitle line when none is given", () => {
		const { container } = render(ArtifactCard, { view: view() });
		expect(container.querySelector(".artifact-card-subtitle")).toBeNull();
	});

	it("renders a tickable view's first five items and '+N more'", async () => {
		const onToggle = vi.fn();
		const items = Array.from({ length: 7 }, (_, index) => ({
			id: `item-${index}`,
			text: `Task ${index}`,
			done: false,
		}));
		render(ArtifactCard, {
			view: view({ tickable: { items, onToggle } }),
		});

		for (let index = 0; index < 5; index += 1) {
			expect(screen.getByText(`Task ${index}`)).toBeInTheDocument();
		}
		expect(screen.queryByText("Task 5")).not.toBeInTheDocument();
		expect(screen.getByText("+2 more")).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("checkbox", { name: "Task 0" }));
		expect(onToggle).toHaveBeenCalledWith("item-0");
	});

	// The in-chat card for Document/App/Canvas/Slides (cross-kind task, after
	// Slice 1): unlike File, these four kinds have no host-drawn title of
	// their own in ToolActivityRow — the row's own line is a generic
	// "Created/Edited <title>", never "kind · subtitle" — so chrome="body"
	// renders the SAME markup chrome="full" does for them, icon and all.
	it("chrome=body renders the full header (icon, title, kind, subtitle, Open) for every kind but File", () => {
		render(ArtifactCard, {
			view: view({
				kind: "document",
				title: "Weekend checklist",
				subtitle: "Document · 2 tabs",
				openTargetId: "artifact-1",
			}),
			chrome: "body",
		});

		expect(screen.getByTestId("artifact-card")).toBeInTheDocument();
		expect(screen.getByText("Weekend checklist")).toBeInTheDocument();
		expect(screen.getByText("Document")).toBeInTheDocument();
		expect(screen.getByText("Document · 2 tabs")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
	});

	it("chrome=body still renders nothing but the lazy File body for kind file", async () => {
		render(ArtifactCard, {
			view: view({ kind: "file", title: "Quarterly report" }),
			job: makeJob({ status: "running" }),
			chrome: "body",
		});
		await screen.findByText("Generating files in the background.");
		expect(screen.queryByTestId("artifact-card")).not.toBeInTheDocument();
	});

	it("does not statically import FileProductionCard.svelte", () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(
			path.join(here, "ArtifactCard.svelte"),
			"utf-8",
		);
		// A static top-level import would put the File body's chunk in every
		// chat page's bundle. Only a dynamic import() (inside the $effect) may
		// name the module.
		const staticImportPattern =
			/^\s*import\s+.*FileProductionCard\.svelte['"]/m;
		expect(staticImportPattern.test(source)).toBe(false);
		expect(source).toContain('import("../chat/FileProductionCard.svelte")');
	});
});
