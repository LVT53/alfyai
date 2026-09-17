import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ADVANCED_KEY_SPECS,
	UNWIRED_ADMIN_CONFIG_KEYS,
} from "$lib/config/admin-config-registry";
import { uiLanguage } from "$lib/stores/settings";
import AdvancedPage from "./AdvancedPage.svelte";
import { pageForKey } from "./pages";

// The Advanced page renders a row for every key in the registry, including the
// five that `effect: "unwired"` says nothing reads. Those five used to render
// an ordinary editable field: an admin could type a sandbox timeout of two
// minutes, press Save, be told "Configuration saved." and have changed nothing
// whatsoever. The only sign was a small "no effect yet" chip four columns away.
//
// The rows stay — someone hunting for the key should find it and learn why it
// does nothing — but nothing on them may accept input.

function renderPage(overrides: Record<string, unknown> = {}) {
	const setValue = vi.fn();
	const result = render(AdvancedPage, {
		adminConfig: {},
		envDefaults: {},
		isDirty: () => false,
		setValue,
		resetValue: vi.fn(),
		revertValue: vi.fn(),
		...overrides,
	});
	return { ...result, setValue };
}

/** The <input>/<select> inside a row, whatever control kind it is. */
function controlIn(row: HTMLElement): HTMLElement {
	const control = row.querySelector("input, select, textarea, button[role]");
	if (!control) throw new Error("row has no control");
	return control as HTMLElement;
}

describe("AdvancedPage — keys nothing reads", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("still shows every one of them", () => {
		// Hiding the row would be a different lie: the key exists, it is in the
		// environment file, and an admin who greps for it deserves an answer.
		renderPage();
		for (const key of UNWIRED_ADMIN_CONFIG_KEYS) {
			expect(
				screen.getByTestId(`advanced-row-${key}`),
				key,
			).toBeInTheDocument();
		}
	});

	it("makes their control read-only and says so in the row", () => {
		renderPage();
		for (const key of UNWIRED_ADMIN_CONFIG_KEYS) {
			const row = screen.getByTestId(`advanced-row-${key}`);
			expect(row.getAttribute("data-unwired"), key).toBe("true");
			expect(controlIn(row), key).toBeDisabled();
			expect(
				screen.getByTestId(`advanced-unwired-note-${key}`).textContent,
				key,
			).toContain("Not connected yet");
		}
	});

	it("does not offer to reset a value that cannot be set", () => {
		// The reset button writes "" through setValue, which would mark the key
		// dirty and put it in a save the server is going to refuse.
		renderPage({ adminConfig: { TEI_RERANKER_MODEL: "bge-reranker-v2-m3" } });
		const row = screen.getByTestId("advanced-row-TEI_RERANKER_MODEL");

		expect(row.querySelector("button.sys-mini")).toBeNull();
	});

	it("reports no change when someone drives the disabled field anyway", async () => {
		const { setValue } = renderPage();
		const row = screen.getByTestId(
			"advanced-row-FILE_PRODUCTION_SANDBOX_TIMEOUT_MS",
		);

		await fireEvent.change(controlIn(row), { target: { value: "120" } });

		expect(setValue).not.toHaveBeenCalled();
	});

	it("leaves the wired rows alone", () => {
		// The guard must be scoped to the five, not applied to the page.
		renderPage();
		const wired = ADVANCED_KEY_SPECS.filter(
			(spec) => spec.effect !== "unwired" && spec.control.kind === "int",
		);
		expect(wired.length).toBeGreaterThan(0);
		for (const spec of wired.slice(0, 5)) {
			const row = screen.queryByTestId(`advanced-row-${spec.key}`);
			if (!row) continue;
			expect(row.getAttribute("data-unwired"), spec.key).toBeNull();
			expect(controlIn(row), spec.key).not.toBeDisabled();
		}
	});

	it("counts only the settings that do something, and names the rest", () => {
		const { container } = renderPage();
		// Same population the page renders: registry keys this page owns.
		const owned = ADVANCED_KEY_SPECS.filter(
			(spec) => pageForKey(spec.key) === "advanced",
		);
		const inertOwned = owned.filter((spec) =>
			UNWIRED_ADMIN_CONFIG_KEYS.has(spec.key),
		);
		const wiredCount = owned.length - inertOwned.length;
		expect(inertOwned.length).toBeGreaterThan(0);

		const headline = container.querySelector(".sys-card-desc");
		// The headline promises "saving here is enough — no restart, no
		// deploy", which is false for an inert key, so it must not be counted.
		expect(headline?.textContent).toContain(`${wiredCount} settings`);
		expect(headline?.textContent).not.toContain(`${owned.length} settings`);
		expect(screen.getByTestId("advanced-unwired-count").textContent).toContain(
			String(inertOwned.length),
		);
	});

	it("says the note in Hungarian too", () => {
		uiLanguage.set("hu");
		renderPage();

		expect(
			screen.getByTestId("advanced-unwired-note-TEI_RERANKER_MODEL")
				.textContent,
		).toContain("Még nincs bekötve");
	});
});
