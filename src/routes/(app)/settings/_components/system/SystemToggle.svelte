<script lang="ts">
// The one toggle idiom for the whole System screen. The old pane had three
// (a hand-rolled `peer sr-only` checkbox, a bare checkbox, and the settings
// page's `.toggle-btn`); this replaces all of them.
import "./system.css";

let {
	checked = false,
	disabled = false,
	label,
	describedBy = undefined,
	onchange,
	id = undefined,
}: {
	checked?: boolean;
	disabled?: boolean;
	/** Accessible name. Rendered as aria-label, so it must be plain text. */
	label: string;
	describedBy?: string | undefined;
	onchange: (next: boolean) => void;
	id?: string | undefined;
} = $props();
</script>

<button
	{id}
	type="button"
	role="switch"
	class="sys-toggle"
	aria-checked={checked}
	aria-label={label}
	aria-describedby={describedBy}
	{disabled}
	onclick={() => onchange(!checked)}
>
	<span class="sys-toggle-thumb"></span>
</button>
