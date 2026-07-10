# Account Erasure Keeps Only Anonymous Aggregates

> **See also [ADR-0049](0049-analytics-excluded-users.md):** admins can additionally *exclude* still-identified users (including deleted-but-not-erased ones) from System Analytics dashboards without deleting rows — a presentation filter, distinct from the data removal described here.

Account Erasure removes person-linked local and app-controlled external account data, including analytics rows that retain user identity, email, name, conversation titles, or message identity. We keep only anonymous aggregate usage and cost totals after erasure, rather than pseudonymous per-user history, because retained person-shaped analytics would be easy to reidentify and would make deletion misleading despite preserving useful operational totals.
