import type { Config } from 'tailwindcss';

export default {
	darkMode: 'class',
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			colors: {
				primary: 'var(--bg-primary)',
				secondary: 'var(--bg-secondary)',
				message: {
					user: 'var(--bg-message-user)',
					assistant: 'var(--bg-message-assistant)'
				},
				code: 'var(--bg-code)',
				hover: 'var(--bg-hover)',
				text: {
					primary: 'var(--text-primary)',
					secondary: 'var(--text-secondary)',
					code: 'var(--text-code)',
					muted: 'var(--text-muted)'
				},
				accent: {
					DEFAULT: 'var(--accent)',
					hover: 'var(--accent-hover)',
					// Artifacts redesign §9.1: small text/filled-button variants of
					// --accent that clear 4.5:1 (the raw --accent is 4.0:1 on the
					// page in light) — see artifact-color-contrast.test.ts.
					text: 'var(--accent-text)',
					fill: 'var(--accent-fill)',
					tint: 'var(--accent-tint)',
					tintStrong: 'var(--accent-tint-strong)'
				},
				// Artifacts redesign §9.1: the text colour for a filled --accent-fill
				// button/badge (white in light, near-black in dark).
				'on-accent': 'var(--on-accent)',
				border: {
					DEFAULT: 'var(--border-default)',
					subtle: 'var(--border-subtle)',
					focus: 'var(--border-focus)'
				},
				// Semantic Surface Tokens
				surface: {
					page: 'var(--surface-page)',
					elevated: 'var(--surface-elevated)',
					overlay: 'var(--surface-overlay)',
					code: 'var(--surface-code)'
				},
				// Semantic Icon Tokens
				icon: {
					primary: 'var(--icon-primary)',
					muted: 'var(--icon-muted)'
				},
				// Semantic Status Tokens
				danger: {
					DEFAULT: 'var(--danger)',
					hover: 'var(--danger-hover)'
				},
				success: {
					DEFAULT: 'var(--success)',
					hover: 'var(--success-hover)',
					// Artifacts redesign §9.1: "Facts checked" / "Paid" status pills.
					text: 'var(--success-text)',
					tint: 'var(--success-tint)'
				},
				// Artifacts redesign §9.1: replaces the undefined --status-warning-*
				// tokens (a refusal notice, a warning status pill).
				warning: {
					DEFAULT: 'var(--warning)',
					hover: 'var(--warning-hover)',
					text: 'var(--warning-text)',
					tint: 'var(--warning-tint)'
				},
				// Canvas (Feature 2, Slice 3): the four sticky-note fills, the map
				// block's paper tint and the four drawing inks — see app.css.
				sticky: {
					yellow: 'var(--sticky-yellow)',
					mint: 'var(--sticky-mint)',
					blue: 'var(--sticky-blue)',
					plain: 'var(--sticky-plain)'
				},
				'map-paper': 'var(--map-paper)',
				ink: {
					blue: 'var(--ink-blue)',
					red: 'var(--ink-red)',
					green: 'var(--ink-green)',
					graphite: 'var(--ink-graphite)'
				},
				// Focus Ring
				'focus-ring': 'var(--focus-ring)'
			},
			zIndex: {
				// A board's own overlays, inside the board's stacking context.
				'artifact-overlay': 'var(--artifact-overlay-z)'
			},
			spacing: {
				'xs': 'var(--space-xs)',
				'sm': 'var(--space-sm)',
				'md': 'var(--space-md)',
				'lg': 'var(--space-lg)',
				'xl': 'var(--space-xl)',
				'2xl': 'var(--space-2xl)',
			},
			borderRadius: {
				'sm': 'var(--radius-sm)',
				'md': 'var(--radius-md)',
				'lg': 'var(--radius-lg)',
				'full': 'var(--radius-full)',
			},
			boxShadow: {
				'sm': 'var(--shadow-sm)',
				'md': 'var(--shadow-md)',
				'lg': 'var(--shadow-lg)',
			},
		transitionDuration: {
			'micro': 'var(--duration-micro)',
			'150': 'var(--duration-standard)',
			'250': 'var(--duration-emphasis)',
			'emphasis': 'var(--duration-emphasis)',
			// Artifacts redesign §9.1: a highlight settling.
			'700': 'var(--duration-settle)',
			'settle': 'var(--duration-settle)',
		},
			fontFamily: {
				sans: ["var(--font-sans)"],
				serif: ["var(--font-serif)"],
				mono: ["var(--font-mono)"],
			},
			fontSize: {
				'2xs': 'var(--text-2xs)',
				'xs': 'var(--text-xs)',
				'sm': 'var(--text-sm)',
				'md': 'var(--text-md)',
				'base': 'var(--text-base)',
				'lg': 'var(--text-lg)',
			},
		},
	},
	plugins: [require('@tailwindcss/typography')],
};
