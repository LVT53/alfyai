# Skill packs and variants

> **Amended, 2026-09-06 (on-demand skill loading).** Packs and overlay-only variants are unchanged, but there is no **Skill Session** to snapshot effective instructions any more: every load resolves the current pack plus the variant overlay for that one turn, so a pack update takes effect on the next turn rather than on the next activation. The "session started before a pack update keeps its captured instructions" scenario below no longer applies.

AlfyAI will model reusable admin-maintained skill guidance as **Skill Packs** and user personalization as **Skill Variants**, not as copied private skill definitions.

A **Skill Pack** is the shared base guidance for a system or admin-managed skill. It may include internal admin/system resources that help keep high-quality built-in skills consistent. A **Skill Variant** is a user-owned overlay that references the current pack and stores only the user's customization.

When a user activates a pack-backed skill, AlfyAI resolves the effective instructions from the current **Skill Pack** plus the **Skill Variant** overlay when one is selected. The resulting effective instructions keep the existing **Skill Session** snapshot behavior: an already-running active session keeps the effective instructions captured when that session started unless the user explicitly restarts or updates it.

Admins may silently update a **Skill Pack**. Future direct pack activations and future variant activations inherit the current pack base. Existing variants do not copy or pin the base instructions, so quality updates, style improvements, and safety fixes can propagate without migration or manual rebasing.

The user editor for a **Skill Variant** is overlay-only. Admin pack content and internal resources are managed separately, which avoids the single-textarea problem where private customization and admin/system base instructions become indistinguishable.

No private-skill migration is needed now because there is no existing private skill data to preserve for this feature. If later work introduces standalone private skills before variants ship, that migration should be designed separately from this decision.

For an OpenAI spreadsheet skill adaptation, the **Skill Pack** should keep transferable spreadsheet quality guidance: workbook structure, formulas, chart readability, verification, visual polish, and domain-specific conventions. Codex-specific runtime instructions must be replaced with AlfyAI file production guidance: use `produce_file`, `sourceMode: "program"`, JavaScript `exceljs`, and final files written to `/output` so results appear through the durable **File Production Card** path. The pack must not promise Google Drive import, local Markdown file links, `@oai/artifact-tool`, or artifact-tool render/inspect APIs.

**Considered Options**

- Keep one editable **Skill Definition** textarea that mixes admin base instructions with user customization.
- Let users clone or copy system skills into private editable definitions.
- Pin each user personalization to the pack version that existed when it was created.
- Use live **Skill Pack** references plus user-owned **Skill Variant** overlays.

We chose live pack references with overlay-only variants because admin-maintained skills need ongoing quality and safety updates, while users still need personal customization. A single textarea blurs ownership and makes updates risky. Clone/copy workflows strand improvements in private forks and create migration work. Version pinning is safer for repeatability but turns every pack update into user-facing version management. The existing session snapshot rule covers the important stability boundary: in-flight sessions stay stable, while future activations get the current pack.

**Acceptance Scenarios**

- A user can activate a **Skill Pack** directly or activate a **Skill Variant** that overlays it.
- A user editing a **Skill Variant** can change only overlay guidance, not admin-managed pack content or resources.
- An admin update to a **Skill Pack** changes future direct pack activations and future variant activations.
- A **Skill Session** started before a pack update continues with its captured effective instructions until explicitly restarted or updated.
- Deleting or disabling a **Skill Variant** does not delete or mutate the underlying **Skill Pack**.
- V1 avoids generic clone, copy, import, marketplace, and plugin-style skill distribution flows.
- Spreadsheet pack guidance produces `.xlsx` outputs through AlfyAI file production rather than Codex artifact APIs or Google Drive import promises.
