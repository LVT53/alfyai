<script lang="ts">
import { fade } from "svelte/transition";

let {
	text,
	delay = 0,
	speed = 6,
	onComplete,
}: {
	text: string;
	delay?: number;
	speed?: number;
	onComplete?: () => void;
} = $props();

let displayedChars = $state<string[]>([]);
let isAnimating = $state(false);
let animationKey = $state(0);
let animationSeed = 0;

$effect(() => {
	if (!text) {
		displayedChars = [];
		isAnimating = false;
		return;
	}

	animationSeed += 1;
	animationKey = animationSeed;
	displayedChars = [];
	isAnimating = true;

	const chars = text.split("");
	const timeoutIds: ReturnType<typeof setTimeout>[] = [];

	chars.forEach((_, index) => {
		timeoutIds.push(
			setTimeout(
				() => {
					displayedChars = chars.slice(0, index + 1);
				},
				delay + index * speed,
			),
		);
	});

	timeoutIds.push(
		setTimeout(
			() => {
				isAnimating = false;
				onComplete?.();
			},
			delay + text.length * speed + 200,
		),
	);

	return () => {
		for (const timeoutId of timeoutIds) {
			clearTimeout(timeoutId);
		}
	};
});
</script>

<span class="typewriter-text" class:animating={isAnimating}>
	{#each displayedChars as char, i (`${animationKey}-${i}`)}
		<span
			in:fade={{
				duration: 20,
				delay: delay + (i * speed)
			}}
			class="char"
			style="animation-delay: {delay + (i * speed)}ms"
		>
			{char === ' ' ? '\u00A0' : char}
		</span>
	{/each}
</span>

<style>
	.typewriter-text {
		display: inline;
	}

	.char {
		display: inline-block;
		will-change: transform, opacity;
		color: var(--text-primary);
		animation: shimmer-in 400ms ease-out forwards;
	}

	@keyframes shimmer-in {
		0% {
			color: var(--accent);
			text-shadow: 0 0 8px rgba(194, 166, 106, 0.6);
		}
		50% {
			color: color-mix(in srgb, var(--accent) 70%, var(--text-primary) 30%);
			text-shadow: 0 0 4px rgba(194, 166, 106, 0.3);
		}
		100% {
			color: var(--text-primary);
			text-shadow: none;
		}
	}
</style>
