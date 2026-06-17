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
					hover: 'var(--accent-hover)'
				},
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
					hover: 'var(--success-hover)'
				},
				// Focus Ring
				'focus-ring': 'var(--focus-ring)'
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
