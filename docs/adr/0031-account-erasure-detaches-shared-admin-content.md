# Account Erasure Detaches Shared Admin Content

Account Erasure removes the erased person from shared admin-authored system content without deleting that shared content. Published campaigns, provider/model configuration, system skills, and similar deployment-level records should survive an admin account deletion with authorship detached or anonymized, because deleting them would break the deployment for other users while retaining the author identity would violate the erasure boundary.

## Update (arch-hardening C7): detach owned by account-lifecycle + registry

`detachSharedContentAuthorship` (reassign `campaign_assets` and system-owned `user_skill_definitions` to the shared detached owner; null out `announcement_campaigns` / snapshot authorship; mark `admin_config.updated_by` detached) now lives in the single account-lifecycle owner and runs **before** the `users` row is deleted — this ordering matters because `campaign_assets.uploaded_by_user_id` cascades, so a shared asset would be destroyed by the cascade if authorship were not detached first. The user-scoped-table registry classifies these tables as `detach` so the enumeration stays complete, and the erasure no-survivor test asserts zero rows remain *keyed to the erased user* (detached rows survive under the shared owner).
