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
*(Implemented in slice E1.)* Each provider carries a `group: "product" | "custom"` field on
both `PROVIDER_META` (server) and the client `PROVIDER_CATALOG` mirror. The "Add a
connection" list renders a visual divider between the two groups so a concrete product
(e.g. Google Calendar) reads distinctly from a generic protocol integration (e.g. CalDAV,
manual IMAP, CardDAV contacts). This section will be finalized when E1 lands.

## Context

Todoist shipped as a read-only v1 tasks connector alongside the CalDAV tasks path (Task
9a/9b). With CalDAV widened to serve calendar/contacts/tasks, Todoist became a redundant
single-capability connector the owner chose to drop. The catalog grouping addresses a
usability point raised in the same review: the flat "Add a connection" list mixed
first-class product integrations with generic protocol adapters, which read as
undifferentiated. The OwnTracks admin-not-configured (HTTP 409) message clarity fix rides
in the same E1 UI slice.
