// Provider-agnostic WebDAV/CalDAV/CardDAV + iCal/vCard toolkit (B3).
//
// This module is the shared DAV library that Apple (providers/apple-caldav.ts),
// the generic CalDAV connector (providers/caldav-tasks.ts), the Apple write
// executor (providers/apple-caldav-write.ts), and Nextcloud Files
// (providers/nextcloud-files.ts) all build on. It used to live inside
// apple-caldav.ts, which doubled as the de-facto shared library while
// nextcloud-files re-implemented the XML layer independently and
// apple-caldav-write re-implemented the write transport — this module ends both
// duplications. Everything here is provider-agnostic: no store access, no
// connection lookup, no per-provider error type or branding (callers inject
// those via the transport's makeError/labels seams).

export {
	ADDRESSBOOK_COLLECTIONS_PROPFIND_BODY,
	ADDRESSBOOK_QUERY_BODY,
	calendarQueryBody,
	type ICalProperty,
	type ParsedICalEvent,
	type ParsedVCard,
	parseICalEvents,
	parseICalProperty,
	parseICalTimestamp,
	parseReportMultistatus,
	parseVCards,
	uidQueryBody,
	unfoldICalLines,
} from "./ical";
export {
	type CalDavRequestOptions,
	type CalDavWriteRequestOptions,
	type ConditionalHeader,
	caldavRequest,
	caldavWriteRequest,
	DavError,
	type DavErrorCode,
} from "./transport";
export {
	CALDAV_NS,
	CARDDAV_NS,
	DAV_NS,
	firstNs,
	isAddressbookCollection,
	isCalendarCollection,
	okPropOf,
	parseXml,
	supportsCalendarComponent,
	textOf,
} from "./xml";
