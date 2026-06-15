export function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function renderArchivePage(params: {
	title: string;
	subtitle?: string;
	body: string;
	nav?: Array<{ href: string; label: string }>;
}): string {
	const navItems = params.nav?.length
		? `<nav class="section-nav" aria-label="Archive sections">${params.nav
				.map(
					(item) =>
						`<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`,
				)
				.join("")}</nav>`
		: "";

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escapeHtml(params.title)}</title>
	<style>
		:root {
			color-scheme: light;
			--surface-page: #fafaf8;
			--surface-overlay: #f7f6f2;
			--surface-plain: #ffffff;
			--text-primary: #1a1a1a;
			--text-muted: #6b6b6b;
			--border-default: rgba(0, 0, 0, 0.08);
			--accent: #c15f3c;
			--accent-quiet: rgba(193, 95, 60, 0.1);
			--gold: #c8a882;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			background: var(--surface-page);
			color: var(--text-primary);
			font-family: "Nimbus Sans L", Arial, sans-serif;
			line-height: 1.55;
		}
		header, main { width: min(980px, calc(100% - 32px)); margin: 0 auto; }
		header { padding: 36px 0 20px; }
		.brand { color: var(--accent); font-size: 0.8rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
		h1 { margin: 8px 0 6px; font-size: clamp(2rem, 5vw, 3.7rem); line-height: 1.02; letter-spacing: 0; }
		h2 { margin: 0 0 14px; font-size: 1.3rem; }
		h3 { margin: 20px 0 8px; font-size: 1rem; }
		p { margin: 0 0 12px; }
		a { color: var(--accent); }
		.section-nav {
			position: sticky;
			top: 0;
			z-index: 2;
			display: flex;
			gap: 8px;
			overflow-x: auto;
			padding: 10px 0;
			background: color-mix(in srgb, var(--surface-page) 90%, transparent);
			backdrop-filter: blur(8px);
		}
		.section-nav a {
			flex: 0 0 auto;
			border: 1px solid var(--border-default);
			border-radius: 999px;
			padding: 7px 11px;
			background: var(--surface-plain);
			text-decoration: none;
			font-size: 0.9rem;
		}
		main { padding: 8px 0 44px; }
		section, article, details {
			background: var(--surface-plain);
			border: 1px solid var(--border-default);
			border-radius: 8px;
			padding: 18px;
			margin: 14px 0;
		}
		summary { cursor: pointer; font-weight: 700; }
		table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; }
		th, td { border-bottom: 1px solid var(--border-default); padding: 8px; text-align: left; vertical-align: top; }
		th { color: var(--text-muted); font-size: 0.85rem; font-weight: 700; }
		.message { border-left: 4px solid var(--border-default); padding-left: 12px; margin: 16px 0; }
		.message.assistant { border-left-color: var(--accent); }
		.meta, .empty { color: var(--text-muted); font-size: 0.9rem; }
		.avatar { max-width: 112px; border-radius: 8px; border: 1px solid var(--border-default); }
		pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-overlay); padding: 12px; border-radius: 6px; }
		ul { padding-left: 1.2rem; }
	</style>
</head>
<body>
	<header>
		<div class="brand">AlfyAI</div>
		<h1>${escapeHtml(params.title)}</h1>
		${params.subtitle ? `<p class="meta">${escapeHtml(params.subtitle)}</p>` : ""}
		${navItems}
	</header>
	<main>
		${params.body}
	</main>
</body>
</html>`;
}

export function renderArchiveEntryPage(params: {
	title: string;
	heroCopy: string;
	preparedFor: string;
	created: string;
	metrics: Array<{ value: string | number; label: string }>;
	sections: Array<{
		id: string;
		title: string;
		subtitle: string;
		body: string;
		open?: boolean;
	}>;
}): string {
	const navItems = params.sections
		.map(
			(section) =>
				`<a href="#${escapeHtml(section.id)}"><span class="nav-dot"></span>${escapeHtml(section.title)}</a>`,
		)
		.join("");
	const metrics = params.metrics
		.map(
			(metric) =>
				`<div class="metric"><div class="metric-value">${escapeHtml(metric.value)}</div><div class="metric-label">${escapeHtml(metric.label)}</div></div>`,
		)
		.join("");
	const sections = params.sections
		.map(
			(section) => `<details id="${escapeHtml(section.id)}" class="section"${
				section.open ? " open" : ""
			}>
					<summary class="section-header">
						<div>
							<h2>${escapeHtml(section.title)}</h2>
							<p class="section-subtitle">${escapeHtml(section.subtitle)}</p>
						</div>
					</summary>
					<div class="section-body">${section.body}</div>
				</details>`,
		)
		.join("");

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escapeHtml(params.title)}</title>
	<style>
		:root {
			--surface-page: #fafaf8;
			--surface-elevated: #f4f3ee;
			--surface-overlay: #f7f6f2;
			--surface-plain: #ffffff;
			--surface-accent: #fff7f2;
			--text-primary: #1a1a1a;
			--text-muted: #6b6b6b;
			--border-default: rgba(0, 0, 0, 0.08);
			--border-strong: rgba(0, 0, 0, 0.16);
			--accent: #c15f3c;
			--accent-quiet: rgba(193, 95, 60, 0.1);
			--gold: #c8a882;
			--green: #2f7d57;
			--blue: #376b8f;
			--danger: #b91c1c;
			--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
			--radius-md: 6px;
			--radius-lg: 8px;
		}
		* { box-sizing: border-box; }
		html {
			background: var(--surface-page);
			color: var(--text-primary);
			font-family: "Nimbus Sans L", Arial, sans-serif;
			font-size: 16px;
			letter-spacing: 0;
		}
		body { margin: 0; background: var(--surface-page); }
		a { color: inherit; text-decoration: none; }
		.archive-shell {
			display: grid;
			grid-template-columns: 17rem minmax(0, 1fr);
			min-height: 100vh;
		}
		.archive-shell > * { min-width: 0; }
		.sidebar {
			position: sticky;
			top: 0;
			height: 100vh;
			min-width: 0;
			padding: 1.25rem;
			border-right: 1px solid var(--border-default);
			background: rgba(250, 250, 248, 0.9);
			backdrop-filter: blur(12px);
		}
		.brand {
			display: flex;
			align-items: center;
			gap: 0.7rem;
			margin-bottom: 1.5rem;
		}
		.logo-box {
			display: grid;
			place-items: center;
			width: 2.35rem;
			height: 2.35rem;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-md);
			background: var(--surface-overlay);
		}
		.brand-title {
			margin: 0;
			font-size: 1rem;
			font-weight: 700;
			line-height: 1.1;
		}
		.brand-subtitle {
			margin: 0.2rem 0 0;
			color: var(--text-muted);
			font-size: 0.78rem;
		}
		.nav-label {
			margin: 0 0 0.55rem;
			color: var(--text-muted);
			font-size: 0.72rem;
			font-weight: 700;
			text-transform: uppercase;
		}
		.nav { display: grid; gap: 0.2rem; max-width: 100%; min-width: 0; }
		.nav a {
			display: flex;
			align-items: center;
			gap: 0.55rem;
			min-width: 0;
			min-height: 2.2rem;
			padding: 0.45rem 0.55rem;
			border-radius: var(--radius-md);
			color: var(--text-muted);
			font-size: 0.92rem;
			transition: background 150ms ease, color 150ms ease;
		}
		.nav a:first-child, .nav a:hover {
			background: var(--accent-quiet);
			color: var(--text-primary);
		}
		.nav-dot {
			width: 0.45rem;
			height: 0.45rem;
			border-radius: 999px;
			background: var(--gold);
		}
		.sidebar-note {
			margin-top: 1.6rem;
			padding: 0.85rem;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-lg);
			background: var(--surface-overlay);
			color: var(--text-muted);
			font-size: 0.82rem;
			line-height: 1.45;
		}
		main { min-width: 0; padding: 2.75rem 2rem; }
		.content { width: min(100%, 72rem); min-width: 0; margin: 0 auto; }
		.hero {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 1.5rem;
			align-items: end;
			padding: 0 0 1.6rem;
			border-bottom: 1px solid var(--border-default);
		}
		h1 {
			margin: 0;
			font-size: clamp(2rem, 5vw, 3.55rem);
			line-height: 0.95;
			letter-spacing: 0;
			overflow-wrap: anywhere;
		}
		.hero-copy {
			max-width: 44rem;
			margin: 1rem 0 0;
			color: var(--text-muted);
			font-size: 1rem;
			line-height: 1.65;
		}
		.archive-stamp {
			min-width: 14rem;
			padding: 1rem;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-lg);
			background: var(--surface-plain);
			box-shadow: var(--shadow-sm);
		}
		.stamp-label { color: var(--text-muted); font-size: 0.78rem; }
		.stamp-value { margin-top: 0.2rem; font-weight: 700; }
		.summary-grid {
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 0.85rem;
			margin: 1.5rem 0 1.75rem;
		}
		.metric {
			padding: 1rem;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-lg);
			background: var(--surface-plain);
		}
		.metric-value { font-size: 1.45rem; font-weight: 700; }
		.metric-label { margin-top: 0.25rem; color: var(--text-muted); font-size: 0.82rem; }
		.section {
			margin: 0 0 0.85rem;
			padding: 0;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-lg);
			background: rgba(255, 255, 255, 0.55);
			box-shadow: var(--shadow-sm);
			overflow: clip;
		}
		.section[open] { background: rgba(255, 255, 255, 0.72); }
		.section-header {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: center;
			gap: 0.9rem;
			padding: 1rem 1.1rem;
			cursor: pointer;
			list-style: none;
		}
		.section-header::-webkit-details-marker { display: none; }
		.section-header::after {
			content: "+";
			display: grid;
			place-items: center;
			width: 1.6rem;
			height: 1.6rem;
			border: 1px solid var(--border-default);
			border-radius: 999px;
			color: var(--text-muted);
			font-weight: 700;
		}
		.section[open] .section-header::after {
			content: "-";
			color: var(--accent);
			border-color: color-mix(in srgb, var(--accent) 38%, transparent);
			background: var(--accent-quiet);
		}
		.section-body { padding: 0 1.1rem 1.1rem; }
		h2 { margin: 0; font-size: 1.18rem; line-height: 1.2; }
		.section-subtitle {
			margin: 0.35rem 0 0;
			color: var(--text-muted);
			font-size: 0.9rem;
			line-height: 1.45;
		}
		.profile-grid, .file-grid, .memory-grid {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 0.7rem;
		}
		.field, .file-tile, .memory-item {
			min-width: 0;
			padding: 0.75rem;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-md);
			background: var(--surface-plain);
		}
		.field-label, .file-kind, .memory-source {
			color: var(--text-muted);
			font-size: 0.75rem;
			text-transform: uppercase;
		}
		.field-value, .file-name, .memory-text {
			margin-top: 0.25rem;
			overflow-wrap: anywhere;
			font-weight: 700;
		}
		.file-meta, .memory-meta {
			margin-top: 0.25rem;
			color: var(--text-muted);
			font-size: 0.78rem;
		}
		.chat-list { display: grid; gap: 0.7rem; }
		.chat-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.8rem;
			align-items: center;
			padding: 0.82rem;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-md);
			background: var(--surface-plain);
		}
		.chat-title { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
		.chat-preview { margin: 0.25rem 0 0; color: var(--text-muted); font-size: 0.88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.chat-meta { color: var(--text-muted); font-size: 0.78rem; text-align: right; white-space: nowrap; }
		.analytics-layout { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr); gap: 0.8rem; }
		table {
			width: 100%;
			border-collapse: collapse;
			overflow: hidden;
			border: 1px solid var(--border-default);
			border-radius: var(--radius-md);
			background: var(--surface-plain);
			font-size: 0.88rem;
		}
		th, td { padding: 0.65rem 0.7rem; border-bottom: 1px solid var(--border-default); text-align: left; }
		th { color: var(--text-muted); font-size: 0.72rem; text-transform: uppercase; }
		tr:last-child td { border-bottom: 0; }
		.notice {
			padding: 0.85rem;
			border: 1px solid rgba(185, 28, 28, 0.22);
			border-radius: var(--radius-md);
			background: rgba(185, 28, 28, 0.055);
			color: #5f1717;
			line-height: 1.45;
		}
		.footer {
			margin: 1.5rem 0 0;
			padding: 1rem 0 0;
			border-top: 1px solid var(--border-default);
			color: var(--text-muted);
			font-size: 0.82rem;
			line-height: 1.5;
		}
		@media (max-width: 940px) {
			.archive-shell { grid-template-columns: 1fr; }
			.sidebar {
				position: static;
				height: auto;
				border-right: 0;
				border-bottom: 1px solid var(--border-default);
			}
			.nav { grid-template-columns: repeat(4, minmax(0, 1fr)); }
			.nav a { justify-content: center; }
			.nav-dot, .sidebar-note { display: none; }
			.hero { grid-template-columns: 1fr; }
			.summary-grid, .profile-grid, .file-grid, .memory-grid, .analytics-layout {
				grid-template-columns: repeat(2, minmax(0, 1fr));
			}
		}
		@media (max-width: 640px) {
			main { padding: 1.15rem 1rem 1.5rem; }
			.sidebar { display: contents; }
			.brand {
				margin: 0;
				padding: 1rem;
				border-bottom: 1px solid var(--border-default);
				background: var(--surface-page);
			}
			.nav-wrap {
				position: sticky;
				top: 0;
				z-index: 25;
				margin: 0;
				padding: 0.7rem 1rem 0.55rem;
				border-bottom: 1px solid var(--border-default);
				background: rgba(250, 250, 248, 0.97);
				backdrop-filter: blur(14px);
			}
			.nav { display: flex; gap: 0.35rem; overflow-x: auto; padding-bottom: 0.2rem; }
			.nav a { flex: 0 0 auto; min-height: 2.75rem; padding-inline: 0.8rem; }
			.summary-grid, .profile-grid, .file-grid, .memory-grid, .analytics-layout {
				grid-template-columns: 1fr;
			}
			.section-header, .chat-row { grid-template-columns: minmax(0, 1fr) auto; }
			.chat-meta { text-align: left; white-space: normal; }
			.chat-preview { overflow: visible; text-overflow: clip; white-space: normal; }
		}
	</style>
</head>
<body>
	<div class="archive-shell">
		<aside class="sidebar">
			<div class="brand" aria-label="AlfyAI">
				<div class="logo-box">
					<svg width="28" height="31" viewBox="0 0 100 112" aria-hidden="true">
						<path fill="none" stroke="#C8A882" stroke-width="4.2" stroke-linecap="round" d="M50 19 C46 40 36 64 24 88"></path>
						<path fill="none" stroke="#C8A882" stroke-width="4.2" stroke-linecap="round" d="M50 19 C54 40 64 64 76 88"></path>
						<line x1="27" y1="57" x2="73" y2="57" stroke="#C8A882" stroke-width="2.2" stroke-linecap="round"></line>
						<circle cx="50" cy="19" r="3.5" fill="#C8A882"></circle>
					</svg>
				</div>
				<div>
					<p class="brand-title">AlfyAI</p>
					<p class="brand-subtitle">Data Archive</p>
				</div>
			</div>
			<div class="nav-wrap">
				<p class="nav-label">Archive sections</p>
				<nav class="nav" aria-label="Archive sections">${navItems}</nav>
			</div>
			<div class="sidebar-note">Links in this archive open files stored inside the same ZIP.</div>
		</aside>
		<main>
			<div class="content">
				<header class="hero">
					<div>
						<h1>${escapeHtml(params.title)}</h1>
						<p class="hero-copy">${escapeHtml(params.heroCopy)}</p>
					</div>
					<div class="archive-stamp" aria-label="Archive details">
						<div class="stamp-label">Prepared for</div>
						<div class="stamp-value">${escapeHtml(params.preparedFor)}</div>
						<div class="stamp-label" style="margin-top:0.65rem;">Created</div>
						<div class="stamp-value">${escapeHtml(params.created)}</div>
					</div>
				</header>
				<section class="summary-grid" aria-label="Archive summary">${metrics}</section>
				${sections}
				<footer class="footer">This archive reflects data saved at the time it was created. If memory, knowledge, or workspace data was cleared earlier, deleted content is not recovered here.</footer>
			</div>
		</main>
	</div>
</body>
</html>`;
}
