// Provider-agnostic WebDAV/CalDAV/CardDAV XML layer (B3). Lifted verbatim out
// of providers/apple-caldav.ts, which used to double as the de-facto shared DAV
// library: Apple, the generic CalDAV connector, and nextcloud-files all parse
// the same 207 multistatus shape, and each had grown (or copied) its own
// namespace-aware DOM walk + propstat-200 selection. This module owns that once.
//
// jsdom is a real (non-dev) dependency already used server-side (see
// web-research/extraction.ts and every WebDAV provider) as a namespace-aware
// XML parser for multistatus responses — reused here rather than pulling in a
// dedicated XML package. Loaded via createRequire, same as those call sites.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
	JSDOM: new (
		xml: string,
		options?: Record<string, unknown>,
	) => { window: { document: Document } };
};

// WebDAV core namespace. Nextcloud-files declared this as its own `DAV_NS =
// "DAV:"` const, identical to Apple's — confirming both agree on the exact URI.
export const DAV_NS = "DAV:";
export const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";
export const CARDDAV_NS = "urn:ietf:params:xml:ns:carddav";

export function parseXml(xml: string): Document {
	const dom = new JSDOM(xml, { contentType: "application/xml" });
	return dom.window.document;
}

export function textOf(el: Element | null | undefined): string | null {
	if (!el) return null;
	const text = el.textContent;
	if (text === null) return null;
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function firstNs(
	el: Element | Document,
	ns: string,
	localName: string,
): Element | null {
	const found = el.getElementsByTagNameNS(ns, localName);
	return found.length > 0 ? (found[0] as Element) : null;
}

// Finds the "winning" propstat (the one with a 200 status, falling back to the
// first if none is explicitly 200) and returns its <prop> element — the same
// "which propstat has the actual values" logic every multistatus <response>
// parser needs, written once here rather than five times across the providers.
export function okPropOf(responseEl: Element): Element | null {
	const propstats = Array.from(
		responseEl.getElementsByTagNameNS(DAV_NS, "propstat"),
	);
	const okPropstat =
		propstats.find((ps) => {
			const status = textOf(firstNs(ps, DAV_NS, "status"));
			return status ? / 200 /.test(` ${status} `) : false;
		}) ?? propstats[0];
	return okPropstat ? firstNs(okPropstat, DAV_NS, "prop") : null;
}

// True when `prop` (a <response>'s winning propstat prop, see okPropOf) has a
// CALDAV:calendar resourcetype — a pure WebDAV collection (e.g. the home-set
// root itself) does not.
export function isCalendarCollection(prop: Element): boolean {
	const resourcetype = firstNs(prop, DAV_NS, "resourcetype");
	return resourcetype
		? resourcetype.getElementsByTagNameNS(CALDAV_NS, "calendar").length > 0
		: false;
}

// True when `prop`'s supported-calendar-component-set includes a
// <c:comp name="componentName"/> (e.g. "VEVENT" or "VTODO").
export function supportsCalendarComponent(
	prop: Element,
	componentName: string,
): boolean {
	const compSet = firstNs(prop, CALDAV_NS, "supported-calendar-component-set");
	if (!compSet) return false;
	const comps = Array.from(compSet.getElementsByTagNameNS(CALDAV_NS, "comp"));
	return comps.some((comp) => comp.getAttribute("name") === componentName);
}

// A response entry is kept when its resourcetype includes CARDDAV:addressbook —
// filters out the home-set root collection itself (which has no addressbook
// resourcetype), mirroring the calendar-collection filter's role for CalDAV.
export function isAddressbookCollection(responseEl: Element): boolean {
	const prop = okPropOf(responseEl);
	if (!prop) return false;
	const resourcetype = firstNs(prop, DAV_NS, "resourcetype");
	return resourcetype
		? resourcetype.getElementsByTagNameNS(CARDDAV_NS, "addressbook").length > 0
		: false;
}
