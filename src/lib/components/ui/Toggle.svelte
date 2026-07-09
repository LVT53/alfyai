<script lang="ts">
let {
	checked = $bindable(false),
	disabled = false,
	ariaLabel,
	onChange,
}: {
	checked?: boolean;
	disabled?: boolean;
	ariaLabel: string;
	onChange?: (next: boolean) => void;
} = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={ariaLabel}
	class="toggle-btn"
	class:toggle-on={checked}
	{disabled}
	onclick={() => {
		if (disabled) return;
		onChange?.(!checked);
	}}
>
	<span class="toggle-thumb"></span>
</button>

<style>
	.toggle-btn {
		position: relative;
		width: 44px;
		height: 24px;
		background: var(--border-default);
		border-radius: 9999px;
		border: none;
		cursor: pointer;
		transition: background var(--duration-standard);
		flex-shrink: 0;
	}

	.toggle-btn.toggle-on {
		background: var(--accent);
	}

	.toggle-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.toggle-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 20px;
		height: 20px;
		background: white;
		border-radius: 9999px;
		transition: transform var(--duration-standard);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
	}

	.toggle-on .toggle-thumb {
		transform: translateX(20px);
	}
</style>
