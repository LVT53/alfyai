import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for Task 7 / C2 ("Visible toggle off-state in settings").
//
// These hand-rolled toggles (`<label><input type="checkbox" class="peer
// sr-only">...<div class="peer ... peer-checked:bg-accent">` ) painted their
// off-state track with `bg-surface-secondary`, an UNDEFINED Tailwind token
// (the `surface` color group only defines `page` / `elevated` / `overlay` /
// `code`) -- so the class compiled to nothing and the off track was fully
// transparent. The fix swaps the track over to `bg-border`
// (`background-color: var(--border-default)`), the exact off-state token the
// canonical `ui/Toggle.svelte` primitive already uses
// (`background: var(--border-default)`), which IS defined for both light and
// dark themes in src/app.css. `peer-checked:bg-accent` (the on-state) is
// untouched.
//
// Some of these toggles (e.g. ProviderList's) sit behind fixture-heavy
// render setups; asserting directly against source text is the reliable,
// low-friction way to lock in "no bg-surface-secondary, always a defined
// track token" across all five sites at once.

const settingsComponentsDir = dirname(fileURLToPath(import.meta.url));

function readComponent(fileName: string): string {
	return readFileSync(join(settingsComponentsDir, fileName), "utf-8");
}

const sites: Array<{ file: string; label: string }> = [
	{
		file: "SettingsAdminSystemPane.svelte",
		label:
			"SettingsAdminSystemPane.svelte (3 toggles: model timeout failover, composer command registry, atlas worker)",
	},
	{
		file: "ProviderList.svelte",
		label: "ProviderList.svelte (provider enabled toggle)",
	},
	{
		file: "ModelForm.svelte",
		label: "ModelForm.svelte (model enabled toggle)",
	},
];

describe("Hand-rolled toggle off-state track uses a defined token (not bg-surface-secondary)", () => {
	for (const { file, label } of sites) {
		it(`${label}: no bg-surface-secondary remains`, () => {
			const source = readComponent(file);
			expect(source).not.toContain("bg-surface-secondary");
		});

		it(`${label}: track uses bg-border and keeps peer-checked:bg-accent`, () => {
			const source = readComponent(file);
			// Every off-track div in these files pairs the fixed track color
			// with the untouched on-state accent transition.
			expect(source).toMatch(/bg-border[^"]*peer-checked:bg-accent/);
		});
	}

	it("SettingsAdminSystemPane.svelte: all three toggle tracks were fixed (bg-border appears 3x)", () => {
		const source = readComponent("SettingsAdminSystemPane.svelte");
		const matches = source.match(/rounded-full bg-border /g) ?? [];
		expect(matches).toHaveLength(3);
	});
});
