<script lang="ts">
// A plain text/number/url/textarea field with an optional unit suffix. It
// never writes an empty string by accident: the caller decides what an empty
// field means, and the value is reported exactly as typed.
import "./system.css";

let {
	id,
	label = undefined,
	value,
	type = "text",
	placeholder = "",
	unit = "",
	size = "md",
	mono = false,
	invalid = false,
	disabled = false,
	rows = 4,
	min = undefined,
	max = undefined,
	maxlength = undefined,
	describedBy = undefined,
	onchange,
}: {
	id: string;
	label?: string | undefined;
	value: string;
	type?: "text" | "number" | "url" | "textarea";
	placeholder?: string;
	unit?: string;
	size?: "sm" | "md" | "lg" | "wide";
	mono?: boolean;
	invalid?: boolean;
	disabled?: boolean;
	rows?: number;
	min?: number | undefined;
	max?: number | undefined;
	maxlength?: number | undefined;
	describedBy?: string | undefined;
	onchange: (next: string) => void;
} = $props();

const sizeClass = $derived(
	size === "sm"
		? "sys-input-sm"
		: size === "md"
			? "sys-input-md"
			: size === "wide"
				? "sys-input-wide"
				: "",
);
</script>

{#if type === 'textarea'}
	<textarea
		{id}
		class={`sys-input sys-input-wide sys-textarea ${invalid ? 'sys-input-invalid' : ''}`}
		class:sys-input-mono={mono}
		aria-label={label}
		aria-invalid={invalid}
		aria-describedby={describedBy}
		{placeholder}
		{rows}
		{disabled}
		{maxlength}
		{value}
		oninput={(event) => onchange(event.currentTarget.value)}
	></textarea>
{:else}
	<span class="sys-field">
		<input
			{id}
			class={`sys-input ${sizeClass} ${invalid ? 'sys-input-invalid' : ''}`}
			class:sys-input-mono={mono}
			type={type === 'number' ? 'number' : type}
			inputmode={type === 'number' ? 'numeric' : undefined}
			aria-label={label}
			aria-invalid={invalid}
			aria-describedby={describedBy}
			{placeholder}
			{disabled}
			{min}
			{max}
			{maxlength}
			{value}
			oninput={(event) => onchange(event.currentTarget.value)}
		/>
		{#if unit}
			<span class="sys-unit">{unit}</span>
		{/if}
	</span>
{/if}
