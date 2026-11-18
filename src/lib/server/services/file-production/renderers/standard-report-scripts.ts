/**
 * The scripts a standard report runs, and the only ones its preview lets run
 * (security review I1, ADR-0068 decision 10). The panel frames a report by its
 * preview's own address, so the report runs under the policy that response carries
 * (`standardReportPreviewCsp` in `file-serving-response-policy.ts`): `script-src`
 * names these scripts by their hashes and nothing else, so no other inline script,
 * inline handler or `javascript:` address in a stored report runs, whatever the
 * report holds. Hashes come only from the app's own code: never from what a stored
 * file happens to contain.
 *
 * A report is stored as it was made and never rendered again, so a report made by an
 * earlier renderer carries that renderer's script: its hash stays listed
 * (`EARLIER_SCRIPT_HASHES`), so its menu keeps working. Change the script below and
 * its old hash goes there (`standard-report-scripts.test.ts` fails until it does).
 */
import { createHash } from "node:crypto";

/**
 * The report's one inline script, as `standard-report-html.ts` writes it: the mobile
 * section menu, the active section, the menu's resizer and the source tooltips. Four
 * fixed parts with no data of the report's, so every report made by this renderer
 * carries the same bytes.
 */
export const STANDARD_REPORT_SCRIPT = [
	"(() => { const sidebar = document.getElementById('report-sidebar'); const backdrop = document.getElementById('sidebar-backdrop'); const button = document.getElementById('mobile-menu-btn'); if (!sidebar || !backdrop || !button) return; const close = () => { sidebar.classList.remove('open'); backdrop.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); }; const open = () => { sidebar.classList.add('open'); backdrop.classList.add('open'); button.setAttribute('aria-expanded', 'true'); }; button.addEventListener('click', () => sidebar.classList.contains('open') ? close() : open()); backdrop.addEventListener('click', close); sidebar.querySelectorAll('a').forEach((link) => link.addEventListener('click', close)); })();",
	"(() => { const reportContent = document.getElementById('report-content'); const reportNavLinks = Array.from(document.querySelectorAll('.report-nav a')); if (!reportContent || reportNavLinks.length === 0) return; const navIds = new Set(reportNavLinks.map((link) => (link.getAttribute('href') || '').slice(1))); const reportSections = Array.from(document.querySelectorAll('.report-section[id]')).filter((section) => navIds.has(section.id)); if (reportSections.length === 0) return; function updateActiveSection() { const contentRect = reportContent.getBoundingClientRect(); const threshold = contentRect.top + Math.min(160, contentRect.height * 0.35); const atScrollEnd = reportContent.scrollTop + reportContent.clientHeight >= reportContent.scrollHeight - 32; let activeId = atScrollEnd ? reportSections[reportSections.length - 1].id : reportSections[0].id; if (!atScrollEnd) { for (const section of reportSections) { const rect = section.getBoundingClientRect(); if (rect.top <= threshold && rect.bottom > contentRect.top + 8) activeId = section.id; } } reportNavLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === '#' + activeId)); } reportContent.addEventListener('scroll', updateActiveSection, { passive: true }); reportNavLinks.forEach((link) => link.addEventListener('click', (event) => { const href = link.getAttribute('href') || ''; if (!href.startsWith('#')) return; const target = document.getElementById(href.slice(1)); if (!target) return; event.preventDefault(); target.scrollIntoView({ block: 'start' }); window.setTimeout(updateActiveSection, 80); })); updateActiveSection(); })();",
	"(() => { const sidebar = document.getElementById('report-sidebar'); const resizer = document.getElementById('report-sidebar-resizer'); if (!sidebar || !resizer) return; const minWidth = 180; const maxWidth = 380; const clampWidth = (width) => Math.max(minWidth, Math.min(maxWidth, width)); function positionReportSidebar(width) { sidebar.style.width = clampWidth(width) + 'px'; } let startX = 0; let startWidth = 0; const onMove = (event) => positionReportSidebar(startWidth + event.clientX - startX); const stopResize = () => { document.documentElement.classList.remove('is-resizing-report-sidebar'); window.removeEventListener('pointermove', onMove); }; resizer.addEventListener('pointerdown', (event) => { if (window.matchMedia('(max-width: 760px)').matches) return; event.preventDefault(); startX = event.clientX; startWidth = sidebar.getBoundingClientRect().width; document.documentElement.classList.add('is-resizing-report-sidebar'); window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', stopResize, { once: true }); window.addEventListener('pointercancel', stopResize, { once: true }); }); resizer.addEventListener('keydown', (event) => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); const delta = event.key === 'ArrowLeft' ? -16 : 16; positionReportSidebar(sidebar.getBoundingClientRect().width + delta); }); })();",
	"(() => { const reportContent = document.getElementById('report-content'); const reportSidebar = document.getElementById('report-sidebar'); const triggers = Array.from(document.querySelectorAll('.source-chip,.honesty-marker,.basis-marker')); function sidebarSafeLeft() { if (!reportSidebar || window.matchMedia('(max-width: 760px)').matches) return 12; const rect = reportSidebar.getBoundingClientRect(); return rect.width > 0 ? Math.max(12, rect.right + 12) : 12; } function positionFloatingTooltips(trigger) { const tooltip = trigger.querySelector('.source-tooltip,.honesty-tooltip,.basis-tooltip'); if (!tooltip) return; tooltip.classList.remove('tooltip-below'); const triggerRect = trigger.getBoundingClientRect(); const tooltipRect = tooltip.getBoundingClientRect(); const margin = 12; const tooltipWidth = Math.min(tooltipRect.width || 280, window.innerWidth - margin * 2); const tooltipHeight = tooltipRect.height || 80; const minLeft = sidebarSafeLeft(); const maxLeft = window.innerWidth - margin; let left = triggerRect.left + triggerRect.width / 2; left = Math.max(minLeft + tooltipWidth / 2, Math.min(maxLeft - tooltipWidth / 2, left)); let top = triggerRect.top - margin; let transform = 'translate(-50%,-100%)'; if (top - tooltipHeight < margin) { top = triggerRect.bottom + margin; transform = 'translate(-50%,0)'; tooltip.classList.add('tooltip-below'); } tooltip.style.setProperty('--tooltip-left', left + 'px'); tooltip.style.setProperty('--tooltip-top', top + 'px'); tooltip.style.setProperty('--tooltip-transform', transform); } function positionVisibleTooltips() { document.querySelectorAll('.source-chip:hover,.source-chip:focus,.honesty-marker:hover,.honesty-marker:focus,.basis-marker:hover,.basis-marker:focus').forEach((trigger) => positionFloatingTooltips(trigger)); } triggers.forEach((trigger) => { trigger.addEventListener('mouseenter', () => positionFloatingTooltips(trigger)); trigger.addEventListener('focus', () => positionFloatingTooltips(trigger)); }); reportContent?.addEventListener('scroll', positionVisibleTooltips, { passive: true }); window.addEventListener('resize', positionVisibleTooltips); })();",
].join("");

/** The fallback on a source's favicon (`onerror`): the neutral globe when the icon cannot be drawn. */
export const STANDARD_REPORT_FAVICON_FALLBACK =
	"this.hidden=true;this.nextElementSibling.hidden=false;";

/** A text's CSP hash source: `'sha256-<base64>'`. */
export function cspSha256(text: string): string {
	return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/**
 * The scripts earlier renderers wrote, taken from git history of
 * `standard-report-html.ts` (the renderer before 2026-06-20 wrote none). Reports made
 * by them are stored with them and still run them.
 */
const EARLIER_SCRIPT_HASHES = [
	// 2c276fa31..47bc3c8e4, 2026-06-21 to 2026-06-26
	"'sha256-qTRY6gb/sCc8Am548y72GmJxxHkD9h0WShaT/13tGbI='",
	// b12a2f650..28ddc37ac, 2026-06-20
	"'sha256-b+Xcvg56Kt550IH7taonhV8HMD4rYVYmWz9it0I3s3I='",
	// d5fd06784..664796ec9, 2026-06-20
	"'sha256-TK5l8g1/dfEMpvFHS+PwnGBSwxEbqC3YsNwcORa0BMc='",
	// bcf1a3832..d81902ef9, 2026-06-20
	"'sha256-JB+wFcGFP8LDI20UESR0Orjvc9gOa1GioWYlQ0p86OM='",
	// 463d7bac8, 2026-06-20
	"'sha256-QIBgiiDYQXRjZfbmthvuEWl9I9EtlZSqn9nTsrBWeJs='",
] as const;

/** Every script a standard report may run: today's, then the earlier ones. */
export const STANDARD_REPORT_SCRIPT_HASHES: readonly string[] = [
	...new Set([cspSha256(STANDARD_REPORT_SCRIPT), ...EARLIER_SCRIPT_HASHES]),
];

/**
 * Every inline handler a standard report may run (`'unsafe-hashes'`): the favicon
 * fallback, the only one any renderer has written (since 2026-06-20, unchanged).
 */
export const STANDARD_REPORT_HANDLER_HASHES: readonly string[] = [
	cspSha256(STANDARD_REPORT_FAVICON_FALLBACK),
];
