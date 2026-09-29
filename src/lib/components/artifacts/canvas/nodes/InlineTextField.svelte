<script lang="ts">
/**
 * The text a note or a text block says, and how a reader edits it in place.
 * At rest it is plain text (so the block stays draggable by its body and a
 * double-click is free to mean "edit"); editing lays a textarea over that same
 * text, which is what keeps the block exactly as tall as its words while the
 * reader types — a textarea has no size of its own to grow.
 *
 * Plain text, never HTML: what is typed is stored as typed, and rendered as
 * text. `maxlength` is the same number the body's schema enforces on save,
 * because a block past it would be dropped, not clipped.
 */
let {
	value,
	placeholder,
	label,
	maxlength,
	editing = $bindable(false),
	readonly = false,
	onchange,
}: {
	value: string;
	placeholder: string;
	/** The textarea's accessible name. */
	label: string;
	maxlength: number;
	editing?: boolean;
	readonly?: boolean;
	onchange: (value: string) => void;
} = $props();

let field = $state<HTMLTextAreaElement | null>(null);

// Focus once the textarea exists, with the caret after the last character.
$effect(() => {
	if (!editing || !field) return;
	field.focus();
	const end = field.value.length;
	field.setSelectionRange(end, end);
});

function stop(): void {
	editing = false;
}

function handleKeydown(event: KeyboardEvent): void {
	// Escape and Ctrl/Cmd+Enter end the edit and hand focus back to the block,
	// so the reader is not left in a field that has gone. The keystroke is
	// spent here: the panel around the board must not treat it as its own.
	if (
		event.key === "Escape" ||
		(event.key === "Enter" && (event.metaKey || event.ctrlKey))
	) {
		event.preventDefault();
		event.stopPropagation();
		const owner = field?.closest<HTMLElement>(".svelte-flow__node");
		stop();
		owner?.focus();
	}
}
</script>

<div class="text-field">
	<div
		class="text-field__text"
		class:text-field__text--empty={!value}
		class:text-field__text--covered={editing}
	>{value || placeholder}</div>
	{#if editing && !readonly}
		<textarea
			bind:this={field}
			class="text-field__input nodrag nowheel nopan"
			{value}
			{maxlength}
			placeholder={placeholder}
			aria-label={label}
			spellcheck="true"
			oninput={(event) => onchange(event.currentTarget.value)}
			onblur={stop}
			onkeydown={handleKeydown}
		></textarea>
	{/if}
</div>

<style>
	.text-field {
		position: relative;
		font: inherit;
	}

	/* The text and the textarea share one box and one set of metrics, so the
	   textarea lands exactly over the words it edits. */
	.text-field__text,
	.text-field__input {
		margin: 0;
		padding: var(--field-padding, 0);
		font: inherit;
		line-height: inherit;
		letter-spacing: inherit;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	/* A zero-width space after the text gives a trailing newline its own line
	   (a textarea shows it), without adding a line when there is none. */
	.text-field__text::after {
		content: "\200b";
	}

	.text-field__text--empty {
		color: var(--text-muted);
		font-style: italic;
	}

	/* Covered, not removed: it still sizes the block while the textarea is on top. */
	.text-field__text--covered {
		visibility: hidden;
	}

	.text-field__input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		resize: none;
		overflow: hidden;
		border: 0;
		outline: none;
		background: transparent;
		color: inherit;
		cursor: text;
	}
</style>
