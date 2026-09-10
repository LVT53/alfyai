import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for Task 7 / C2 ("Visible toggle off-state in settings").
//
// The hand-rolled toggles (`<label><input type="checkbox" class="peer
// sr-only">...<div class="peer ... peer-checked:bg-accent">`) painted their
// off-state track with `bg-surface-secondary`, an UNDEFINED Tailwind token
// (the `surface` color group only defines `page` / `elevated` / `overlay` /
// `code`) — so the class compiled to nothing and the off track was fully
// transparent.
//
// The admin System redesign removed the hand-rolled toggles from the System
// pane and the provider list entirely: both now use `system/SystemToggle`,
// whose track is painted from design tokens in `system/system.css`. The guard
// therefore has two halves — the surviving hand-rolled toggle must still use a
// defined token, and the shared toggle must paint BOTH states from tokens that
// exist in light and dark themes.

const settingsComponentsDir = dirname(fileURLToPath(import.meta.url));

function readComponent(fileName: string): string {
	return readFileSync(join(settingsComponentsDir, fileName), "utf-8");
}

const handRolledSites: Array<{ file: string; label: string }> = [
	{
		file: "ModelForm.svelte",
		label: "ModelForm.svelte (model enabled toggle)",
	},
];

const migratedSites: Array<{ file: string; label: string }> = [
	{
		file: "SettingsAdminSystemPane.svelte",
		label: "SettingsAdminSystemPane.svelte",
	},
	{ file: "ProviderList.svelte", label: "ProviderList.svelte" },
];

describe("Hand-rolled toggle off-state track uses a defined token", () => {
	for (const { file, label } of handRolledSites) {
		it(`${label}: no bg-surface-secondary remains`, () => {
			expect(readComponent(file)).not.toContain("bg-surface-secondary");
		});

		it(`${label}: track uses bg-border and keeps peer-checked:bg-accent`, () => {
			expect(readComponent(file)).toMatch(
				/bg-border[^"]*peer-checked:bg-accent/,
			);
		});
	}
});

describe("Migrated toggles use the shared System toggle", () => {
	for (const { file, label } of migratedSites) {
		it(`${label}: no undefined surface token, and no hand-rolled peer track`, () => {
			const source = readComponent(file);
			expect(source).not.toContain("bg-surface-secondary");
			expect(source).not.toContain("peer-checked:bg-accent");
		});
	}

	it("SystemToggle paints both states from tokens defined in app.css", () => {
		const css = readFileSync(
			join(settingsComponentsDir, "system/system.css"),
			"utf-8",
		);
		// Off state: a mix of --text-muted, which every theme defines.
		expect(css).toMatch(
			/\.sys-toggle \{[\s\S]*background: color-mix\(in srgb, var\(--text-muted\)/,
		);
		// On state: the accent, same as the old peer-checked rule.
		expect(css).toMatch(
			/\.sys-toggle\[aria-checked="true"\] \{[\s\S]*background: var\(--accent\)/,
		);
	});
});
