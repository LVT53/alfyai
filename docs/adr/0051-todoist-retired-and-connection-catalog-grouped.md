# Todoist Retired; Connection Catalog Grouped

Two product decisions for the Connections feature, made together during the 2026-07-11
back-end deepening because they touch the same catalog surface. Extends
[ADR-0044](0044-connections-ui-redesign.md) (Connections UI redesign), whose back-end it
does not otherwise change.

## Decisions

**1. Todoist is fully retired from the product.** The Todoist connector (provider module,
connect route, registry + client-catalog entries, brand icon, i18n strings, connect-wizard
form, and the tasks-tool dispatch branch) is removed entirely rather than left dormant.
The **tasks** capability is now served by **CalDAV only** (`CAPABILITY_META.tasks.providers
= ["caldav"]`). A destructive, idempotent Drizzle migration
(`1777140000084_retire_todoist.sql`) deletes every `user_connections` row (and its
encrypted secret) and any `connection_pending_writes` where `provider='todoist'`. The
provider set is enforced only in TypeScript (`CONNECTION_PROVIDERS`), not by a DB CHECK/enum,
so no DDL constraint rebuild was required — the migration is data-only. Rejected:
soft-removal (keep the enum value + rows dormant) — the owner asked for full removal and
dormant rows would keep surfacing a dead provider in health checks and the catalog;
abort-if-any-exist — the owner accepted the data loss outright. NOTE: `list_projects` /
`projectId` were Todoist-specific and are dropped from the tasks tool's user-facing
description; CalDAV has no "project" concept.

**2. The connection catalog is grouped into solid products vs custom integrations.**
*(Shipped in slice E1.)* Each provider carries a `group: "product" | "custom"` field on
both `PROVIDER_META` (server, `registry.ts`) and the client `PROVIDER_CATALOG` mirror
(`provider-catalog.ts`); the two remain deliberately duplicated and are guarded against
drift by a `registry.test.ts` case that asserts `group`/`displayName`/`connectMethod`/
`capabilities` match across the mirrors. **product** (branded products) = nextcloud,
immich, imap (Email), google, apple, plex, owntracks, github, onedrive. **custom** (generic
protocol integrations) = caldav and contacts (CardDAV); `contacts` is resolver-only so it
is tagged `custom` but never appears in the add list. A pure helper
`groupConnectableProviders()` (alongside `CONNECTABLE_PROVIDER_LIST`) splits the connectable
providers into `{ product, custom }`, preserving catalog declaration order within each
group. The "Add a connection" list (`SettingsConnectionsTab.svelte`) renders the two groups
as labeled sub-sections ("Products" / "Custom integrations") separated by a horizontal rule,
so a concrete product (e.g. Google) reads distinctly from a generic protocol integration
(e.g. CalDAV). Todoist, retired in Decision 1 / slice A1, is absent from both mirrors and
the list.

## Context

Todoist shipped as a read-only v1 tasks connector alongside the CalDAV tasks path (Task
9a/9b). With CalDAV widened to serve calendar/contacts/tasks, Todoist became a redundant
single-capability connector the owner chose to drop. The catalog grouping addresses a
usability point raised in the same review: the flat "Add a connection" list mixed
first-class product integrations with generic protocol adapters, which read as
undifferentiated. The OwnTracks admin-not-configured (HTTP 409) message clarity fix rides
in the same E1 UI slice.
