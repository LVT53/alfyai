<script lang="ts">
/**
 * Official "Sign in with Google" button (ADR 0044 / Connections
 * redesign). This is the ONE place brand color is used in the
 * Connections UI — everywhere else uses the neutral, monochrome
 * BrandIcon.svelte. Follows Google's Sign-In branding guidelines: the
 * standard button shape/min-height/padding/type, the unmodified
 * multicolor "G" mark, and light/dark variants driven by the app's
 * `.dark` theme class (see src/app.css). Do not restyle the G mark or
 * the button shape — Google's guidelines require the mark and button
 * proportions to stay as specified.
 *
 * Usage:
 * ```svelte
 * <GoogleSignInButton onClick={startGoogleOAuth} />
 * <GoogleSignInButton onClick={startGoogleOAuth} label="Connect Google" />
 * ```
 */
import { t } from "$lib/i18n";

let {
	onClick,
	label,
	disabled = false,
}: {
	onClick?: () => void;
	label?: string;
	disabled?: boolean;
} = $props();

let resolvedLabel = $derived(label ?? $t("connections.googleSignIn.label"));

function handleClick() {
	if (disabled) return;
	onClick?.();
}
</script>

<button
	type="button"
	class="google-signin-btn"
	{disabled}
	onclick={handleClick}
>
	<span class="google-signin-btn-logo" aria-hidden="true">
		<svg viewBox="0 0 18 18" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
			<path
				fill="#4285F4"
				d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.8741 2.6836-6.615z"
			/>
			<path
				fill="#34A853"
				d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8059.5404-1.8368.8586-3.0477.8586-2.3436 0-4.3282-1.5831-5.036-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"
			/>
			<path
				fill="#FBBC05"
				d="M3.964 10.71c-.18-.5404-.2822-1.1173-.2822-1.71s.1022-1.1696.2822-1.71V4.9582H.9573A8.9965 8.9965 0 0 0 0 9c0 1.4523.3477 2.8268.9573 4.0418L3.964 10.71z"
			/>
			<path
				fill="#EA4335"
				d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.6564 3.5795 9 3.5795z"
			/>
		</svg>
	</span>
	<span class="google-signin-btn-label">{resolvedLabel}</span>
</button>

<style>
	.google-signin-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0;
		height: 40px;
		min-width: 64px;
		padding: 0 12px 0 0;
		border: 1px solid #747775;
		border-radius: 4px;
		background: #fff;
		cursor: pointer;
		transition:
			background var(--duration-standard, 0.15s),
			box-shadow var(--duration-standard, 0.15s);
	}

	.google-signin-btn:hover:not(:disabled) {
		box-shadow:
			0 1px 2px 0 rgba(60, 64, 67, 0.3),
			0 1px 3px 1px rgba(60, 64, 67, 0.15);
	}

	.google-signin-btn:focus-visible {
		outline: 2px solid #4285f4;
		outline-offset: 2px;
	}

	.google-signin-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
		box-shadow: none;
	}

	.google-signin-btn-logo {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		margin: 0 12px;
		flex-shrink: 0;
	}

	.google-signin-btn-label {
		font-family:
			Roboto,
			"Google Sans Text",
			Arial,
			-apple-system,
			BlinkMacSystemFont,
			sans-serif;
		font-size: 14px;
		font-weight: 500;
		letter-spacing: 0.25px;
		color: #1f1f1f;
		line-height: 1;
	}

	:global(.dark) .google-signin-btn {
		background: #131314;
		border-color: #8e918f;
	}

	:global(.dark) .google-signin-btn:hover:not(:disabled) {
		box-shadow:
			0 1px 2px 0 rgba(0, 0, 0, 0.5),
			0 1px 3px 1px rgba(0, 0, 0, 0.3);
	}

	:global(.dark) .google-signin-btn-label {
		color: #e3e3e3;
	}
</style>
