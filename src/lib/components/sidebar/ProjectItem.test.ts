import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectItem from "./ProjectItem.svelte";
import ProjectItemWrapper from "./ProjectItemWrapper.test.svelte";

const project = {
	id: "project-1",
	name: "House tasks",
	sortOrder: 0,
	createdAt: 1,
	updatedAt: 1,
};

describe("ProjectItem", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function parseFixedMenuTop(element: HTMLElement): number {
		const match = /top:\s*([\d.]+)px/.exec(element.getAttribute("style") ?? "");
		if (!match) throw new Error("Expected menu style to include a fixed top.");
		return Number(match[1]);
	}

	function stubViewportAndTriggerRect() {
		const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
		const originalHeight = Object.getOwnPropertyDescriptor(
			window,
			"innerHeight",
		);
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 320,
		});
		Object.defineProperty(window, "innerHeight", {
			configurable: true,
			value: 210,
		});
		const originalGetBoundingClientRect =
			HTMLElement.prototype.getBoundingClientRect;
		const rectSpy = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockImplementation(function getBoundingClientRect(this: HTMLElement) {
				if (this.getAttribute("aria-label") === "Project options") {
					return {
						x: 260,
						y: 166,
						top: 166,
						right: 304,
						bottom: 194,
						left: 276,
						width: 28,
						height: 28,
						toJSON: () => ({}),
					} as DOMRect;
				}
				return originalGetBoundingClientRect.call(this);
			});

		return () => {
			rectSpy.mockRestore();
			if (originalWidth)
				Object.defineProperty(window, "innerWidth", originalWidth);
			if (originalHeight)
				Object.defineProperty(window, "innerHeight", originalHeight);
		};
	}

	it("keeps project pinning out of the project menu", () => {
		render(ProjectItem, {
			project,
			menuOpen: true,
		});

		const menuActions = screen
			.getAllByRole("menuitem")
			.map((button) => button.textContent?.trim());
		expect(menuActions).toEqual(["New chat", "Rename", "Delete"]);
		expect(
			screen.queryByRole("menuitem", { name: "Pin to sidebar" }),
		).not.toBeInTheDocument();
	});

	it("flips the project overflow menu above bottom sidebar rows instead of clipping it", async () => {
		const restoreViewport = stubViewportAndTriggerRect();
		try {
			render(ProjectItemWrapper, {
				project,
			});

			await fireEvent.click(screen.getByLabelText("Project options"));

			const menu = screen.getByRole("menu");
			expect(parseFixedMenuTop(menu)).toBeLessThan(166);
		} finally {
			restoreViewport();
		}
	});

	it("recalculates the project overflow menu after the portal menu has a measured height", async () => {
		const restoreViewport = stubViewportAndTriggerRect();
		const originalOffsetHeight = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			"offsetHeight",
		);
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
			configurable: true,
			get() {
				return this.getAttribute("role") === "menu" ? 176 : 0;
			},
		});
		try {
			render(ProjectItemWrapper, {
				project,
			});

			await fireEvent.click(screen.getByLabelText("Project options"));

			const menu = screen.getByRole("menu");
			await waitFor(() => {
				expect(parseFixedMenuTop(menu)).toBeLessThanOrEqual(22);
			});
		} finally {
			restoreViewport();
			if (originalOffsetHeight) {
				Object.defineProperty(
					HTMLElement.prototype,
					"offsetHeight",
					originalOffsetHeight,
				);
			} else {
				delete (HTMLElement.prototype as unknown as Record<string, unknown>)
					.offsetHeight;
			}
		}
	});

	it("opens the project menu on right-click without toggling the folder", async () => {
		const onToggle = vi.fn();
		render(ProjectItemWrapper, {
			project,
			onToggle,
		});

		await fireEvent.contextMenu(screen.getByTestId("project-drop-target"), {
			clientX: 36,
			clientY: 52,
		});

		expect(onToggle).not.toHaveBeenCalled();
		expect(
			screen.getByRole("menuitem", { name: "Create chat in House tasks" }),
		).toBeInTheDocument();
	});

	it("offers creating a new chat inside the project menu", async () => {
		const onCreateConversation = vi.fn();
		render(ProjectItem, {
			project,
			menuOpen: true,
			onCreateConversation,
		});

		await fireEvent.click(
			screen.getByRole("menuitem", { name: "Create chat in House tasks" }),
		);

		expect(onCreateConversation).toHaveBeenCalledWith({ id: "project-1" });
	});

	it("shows the project-row new chat action outside the overflow menu", () => {
		render(ProjectItem, {
			project,
			onCreateConversation: vi.fn(),
		});

		expect(
			screen.getByRole("button", { name: "Create chat in House tasks" }),
		).toBeInTheDocument();
	});

	it("shows immediate busy state while a project chat is being created", async () => {
		const onCreateConversation = vi.fn();
		render(ProjectItem, {
			project,
			creatingConversation: true,
			onCreateConversation,
		});

		const action = screen.getByRole("button", {
			name: "Create chat in House tasks",
		});
		expect(action).toBeDisabled();
		expect(action).toHaveAttribute("aria-busy", "true");

		await fireEvent.click(action);

		expect(onCreateConversation).not.toHaveBeenCalled();
	});
});
