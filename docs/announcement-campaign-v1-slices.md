# Announcement Campaign V1 Slices

Parent: [ADR 0012 - Announcement campaigns and first-run onboarding](./adr/0012-announcement-campaigns-and-first-run-onboarding.md)

This document breaks Announcement Campaign v1 into independently grabbable tracer-bullet slices. Each slice should leave the app in a stable, demoable state and should preserve the domain language in `CONTEXT.md`.

## Proposed Breakdown

1. **System Default Model And App Version Badge**
   - **Type**: AFK
   - **Blocked by**: None
   - **User stories covered**: Users can inherit the administrator's default model; users can see the current AlfyAI version in the sidebar.

2. **Campaign Asset Upload And Crop Workflow**
   - **Type**: AFK
   - **Blocked by**: None
   - **User stories covered**: Admins can upload real campaign screenshots and produce required desktop/mobile crops.

3. **Draft Campaign Authoring Workbench**
   - **Type**: AFK
   - **Blocked by**: Slice 2
   - **User stories covered**: Admins can create and edit draft campaigns with localized slides, screenshot crops, and exact modal preview.

4. **Publish Immutable Campaign Snapshots**
   - **Type**: AFK
   - **Blocked by**: Slices 2, 3
   - **User stories covered**: Admins can publish validated campaigns, archive published campaigns, and audit historical published content.

5. **User Campaign Modal Delivery**
   - **Type**: AFK
   - **Blocked by**: Slices 1, 4
   - **User stories covered**: Eligible users see one campaign in the app shell, can progress through slides, skip/close, finish, and replay the latest campaign from the App Version Badge.

6. **First-run Onboarding Setup Preferences**
   - **Type**: AFK
   - **Blocked by**: Slices 1, 5
   - **User stories covered**: Users can choose onboarding defaults for language, theme, System default model, explicit model override, and AI style from the setup slide.

7. **Campaign Interaction Analytics**
   - **Type**: AFK
   - **Blocked by**: Slices 4, 5
   - **User stories covered**: Admins can audit whether campaigns were auto-shown, viewed, completed, skipped, replayed, and where users dropped off.

8. **Seed First-run Onboarding Template**
   - **Type**: AFK
   - **Blocked by**: Slices 3, 4, 6
   - **User stories covered**: Admins get a structured onboarding draft scaffold but users see nothing until it is completed and published.

9. **Responsive Polish And Release Verification**
   - **Type**: HITL
   - **Blocked by**: Slices 1-8
   - **User stories covered**: The full v1 feels production-grade on desktop and mobile, with approved visual quality and no demo-prototype gaps.

Review questions:

- Does the granularity feel right, or should any slice be split further?
- Are the dependencies correct?
- Should the final visual verification slice remain HITL, or should it be AFK with a required screenshot artifact?
- Should Campaign Interaction Analytics ship before or after first-run onboarding template seeding?

## Issue 1: System Default Model And App Version Badge

## What to build

Introduce the System Default Preference for model selection and expose the Canonical App Version in the authenticated shell. Users should be able to leave their default model inherited from the administrator's configured default, while the sidebar shows a compact current app version badge beside the AlfyAI title.

This slice also migrates existing model preferences: users whose stored preferred model equals the configured default become inherited System default users; users with a different stored preferred model keep an explicit override.

The App Version Badge should display a muted compact major/minor value and expose the full package version in hover text. If no published campaign exists yet, clicking the badge may do nothing or show a localized empty state, but the visual anchor and version source should be production-ready.

## Acceptance criteria

- [ ] User preferences support inherited System default model selection and explicit model overrides.
- [ ] Existing users whose stored preferred model matches the configured default migrate to System default.
- [ ] New users start with System default model inheritance.
- [ ] Settings/Profile model controls show System default first and distinguish it from explicit model choices.
- [ ] The effective model still resolves to the current administrator-configured default when the user has no override.
- [ ] The sidebar shows a compact muted App Version Badge next to the AlfyAI title.
- [ ] The badge reads from package metadata, not admin-entered configuration.
- [ ] The full package version is available through hover/title or equivalent accessible text.
- [ ] EN/HU strings and tests cover System default display, preference persistence, migration, and version formatting.

## Blocked by

None - can start immediately.

## Issue 2: Campaign Asset Upload And Crop Workflow

## What to build

Create the app-owned Campaign Asset path for admin-managed campaign screenshots. Admins should be able to upload separate desktop and mobile source images, open a dedicated crop modal, produce a 16:10 desktop crop and a 9:16 mobile crop, save those crops, and preview the resulting assets.

Campaign assets are not Knowledge Base documents, chat attachments, or public static files. Draft assets are visible only to admins. Published asset access is handled in a later slice when published snapshots exist.

## Acceptance criteria

- [ ] Admins can upload desktop and mobile source images for a campaign slide asset workflow.
- [ ] The crop modal supports fixed-ratio desktop crop at 16:10 and mobile crop at 9:16.
- [ ] The crop modal supports zoom, repositioning, reset, save, cancel, hover states, pointer cursor styles, and focus-visible states.
- [ ] Saved crops are stored as app-owned Campaign Assets with DB metadata.
- [ ] Draft asset preview routes require admin access.
- [ ] Campaign assets do not appear in the Knowledge Base, document search, chat attachments, or generated-file flows.
- [ ] Upload/crop validation returns field-level errors for unsupported files, missing crops, and oversized inputs.
- [ ] Tests cover admin authorization, crop metadata, asset serving permissions, and image validation.

## Blocked by

None - can start immediately.

## Issue 3: Draft Campaign Authoring Workbench

## What to build

Add a dedicated Campaigns pane to Settings → Administration. Admins should be able to create and edit Draft Announcement Campaigns in a three-zone desktop workbench: campaign list, central editor, and right-side exact modal preview. Smaller screens may stack edit, preview, and history views.

The editor should support campaign-level fields, setup and standard slide layouts, localized slide content, required desktop/mobile cropped screenshots, optional allowlisted internal action destinations, explicit accessible slide move controls, and live EN/HU plus desktop/mobile preview toggles.

This slice does not publish campaigns yet; it makes draft creation and preview complete.

## Acceptance criteria

- [ ] Administration has a dedicated Campaigns pane separate from System and Users.
- [ ] Admins can create, select, edit, save, and delete draft campaigns.
- [ ] Campaign identity is system-generated and not admin-editable.
- [ ] Drafts capture internal name, type, user-facing version, audience, linked app version where applicable, and status metadata.
- [ ] Draft slides support only setup and standard layouts.
- [ ] Each slide has EN/HU title, EN/HU body, EN/HU alt text, desktop crop, and mobile crop fields.
- [ ] Setup slide controls are configurable only for first-run onboarding setup slides.
- [ ] Optional primary actions are limited to allowlisted internal routes.
- [ ] Slide ordering uses explicit accessible move controls, not drag-and-drop.
- [ ] The right preview shows the exact Campaign Modal Layout, not an approximate card mock.
- [ ] The workbench follows AlfyAI visual language: dense admin layout, subtle borders, 8px-or-less radii, restrained color, no nested cards, and polished hover/focus states.
- [ ] EN/HU admin chrome strings and tests cover draft CRUD, validation display, slide movement, route allowlist, and preview mode toggles.

## Blocked by

- Issue 2: Campaign Asset Upload And Crop Workflow.

## Issue 4: Publish Immutable Campaign Snapshots

## What to build

Let admins publish complete draft campaigns into immutable Published Campaign Snapshots. Publishing should run strict Campaign Publish Validation and produce frozen content plus asset references that do not depend on mutable draft state. Published campaigns can be archived and duplicated as new drafts, but published snapshots cannot be edited in place.

This slice also adds read-only published/archived campaign history in the Campaigns pane.

## Acceptance criteria

- [ ] Admins can publish a draft campaign only when strict validation passes.
- [ ] Publish validation covers required localized content, desktop/mobile crops, valid slide order, valid preference controls, valid internal action destinations, and type-specific requirements.
- [ ] First-run onboarding validation requires exactly one setup slide and at least one data disclosure standard slide.
- [ ] Release/update campaign validation requires a linked app version.
- [ ] Publishing creates a Published Campaign Snapshot with frozen slide content and asset references.
- [ ] Published campaign content cannot be edited in place.
- [ ] Admins can archive a published campaign without deleting its historical snapshot.
- [ ] Admins can duplicate a published or archived campaign as a new draft.
- [ ] Published and archived views are read-only and show audit metadata.
- [ ] Published asset serving is available to authenticated campaign viewers only when the asset is referenced by a published snapshot.
- [ ] Tests cover validation failures, immutable snapshots, archive behavior, duplicate-as-draft behavior, and published asset permissions.

## Blocked by

- Issue 2: Campaign Asset Upload And Crop Workflow.
- Issue 3: Draft Campaign Authoring Workbench.

## Issue 5: User Campaign Modal Delivery

## What to build

Deliver published Announcement Campaigns through the authenticated app shell. The app should auto-show exactly one eligible campaign at a time, with first-run onboarding taking precedence. Release/update campaigns should auto-show only after onboarding is no longer pending, and only the latest unseen release/update campaign should auto-show.

Users should be able to navigate campaign slides, skip or close on non-final slides, finish on the final slide, and replay the latest published campaign from the App Version Badge.

## Acceptance criteria

- [ ] The app shell fetches the single eligible auto-show campaign after authenticated layout data is available.
- [ ] First-run onboarding auto-show takes precedence for users who have not completed or dismissed the current onboarding version.
- [ ] Release/update campaigns auto-show only after onboarding is no longer pending.
- [ ] When multiple unseen release/update campaigns exist, only the latest published one auto-shows.
- [ ] The user-facing modal matches the Campaign Modal Layout on desktop and mobile.
- [ ] Skip and the close button mark the campaign version finished for that user and close the modal.
- [ ] Final slide hides Skip and uses Finish instead of Next.
- [ ] Back, Next, Skip, Finish, close, progress segments, and action controls have pointer cursor, hover affordance, focus-visible styling, and keyboard behavior.
- [ ] The App Version Badge replays the latest published campaign without changing completion state.
- [ ] Admin shell preview opens draft content in the same modal with a visible preview marker and no user-state mutation.
- [ ] EN/HU strings and tests cover eligibility, dismissal/completion state, replay behavior, admin preview, focus trap, and responsive modal rendering.

## Blocked by

- Issue 1: System Default Model And App Version Badge.
- Issue 4: Publish Immutable Campaign Snapshots.

## Issue 6: First-run Onboarding Setup Preferences

## What to build

Make the first-run onboarding setup slide functional. Users should be able to choose UI language, theme, model default, explicit model override, and AI style from the setup slide using the same preference authority as Settings. Preference controls appear only on the setup slide in v1.

Preference changes should apply immediately enough for the user to understand the choice, while still persisting through existing settings APIs and respecting validation.

## Acceptance criteria

- [ ] Setup slide can render language, theme, model default, and AI style controls.
- [ ] UI language changes update visible campaign chrome and app language behavior consistently.
- [ ] Theme changes apply to the app and campaign modal.
- [ ] Model controls show System default first, then non-default available explicit model choices.
- [ ] AI style controls reuse available personality profile choices and default style semantics.
- [ ] Preference writes go through the existing user preference authority rather than campaign-only state.
- [ ] Preference controls are unavailable on standard slides and release/update campaigns in v1.
- [ ] Invalid or unavailable model/style choices degrade to safe current defaults.
- [ ] EN/HU strings and tests cover each setup preference, persistence failure behavior, and effective model resolution.

## Blocked by

- Issue 1: System Default Model And App Version Badge.
- Issue 5: User Campaign Modal Delivery.

## Issue 7: Campaign Interaction Analytics

## What to build

Record minimal Campaign Interaction Analytics and show Campaign Analytics Summary inside the admin campaign detail/history surface. This should help admins audit campaign delivery and engagement without expanding the general Analytics tab.

Events include auto-shown, slide viewed, completed, skipped/closed, replay opened, and setup preference changed. Events should be tied to campaign identity, user, timestamp, event type, and slide index where relevant, with no free-form user content or heatmap-style tracking.

## Acceptance criteria

- [ ] Campaign delivery records auto-shown events.
- [ ] Slide navigation records slide viewed events without excessive duplicate spam.
- [ ] Completion, skip/close, replay opened, and setup preference changed events are recorded.
- [ ] Campaign events do not include free-form user content.
- [ ] Admin campaign detail/history shows counts for shown, completed, skipped/closed, replay opened, completion rate, and slide drop-off.
- [ ] Campaign analytics stay in the Campaigns pane and do not appear in the general Analytics tab in v1.
- [ ] Tests cover event recording, duplicate control, user scoping, admin-only summary access, and summary calculations.

## Blocked by

- Issue 4: Publish Immutable Campaign Snapshots.
- Issue 5: User Campaign Modal Delivery.

## Issue 8: Seed First-run Onboarding Template

## What to build

Seed a Draft Announcement Campaign template for first-run onboarding. The template should provide the required v1 onboarding structure so admins can complete real screenshots and content, preview it, validate it, and publish it. It must not auto-publish or auto-show to users.

The seeded draft should include a setup slide, feature introduction slide structure, and required data disclosure slide structure. Any starting copy should be editable admin-authored campaign content, not hardcoded user-facing campaign text.

## Acceptance criteria

- [ ] The app seeds a first-run onboarding draft template when no onboarding draft or published onboarding exists.
- [ ] The template includes a setup slide and data disclosure slide structure.
- [ ] The template remains a draft until an admin completes validation and publishes it.
- [ ] Users never see seeded template content before publish.
- [ ] The template can be edited, previewed, validated, published, archived, and duplicated like any other campaign draft.
- [ ] Seed behavior is idempotent and does not overwrite admin edits.
- [ ] Tests cover seeding, idempotency, no auto-publish behavior, and validation before publish.

## Blocked by

- Issue 3: Draft Campaign Authoring Workbench.
- Issue 4: Publish Immutable Campaign Snapshots.
- Issue 6: First-run Onboarding Setup Preferences.

## Issue 9: Responsive Polish And Release Verification

## What to build

Bring Announcement Campaign v1 to production quality. Verify the full user and admin experience across desktop and mobile, including modal layout, admin workbench layout, crop modal ergonomics, settings integration, shell preview, replay, localization, accessibility, and visual consistency with AlfyAI.

This slice is HITL because the final UI should receive explicit design review before the feature is considered complete.

## Acceptance criteria

- [ ] User campaign modal is visually reviewed and accepted on desktop and mobile.
- [ ] Admin Campaigns pane is visually reviewed and accepted on desktop and narrower layouts.
- [ ] Crop modal is usable with real desktop and mobile screenshots.
- [ ] No campaign UI text overlaps or overflows in English or Hungarian.
- [ ] All clickable elements have pointer cursor, hover states, focus-visible states, and disabled states where relevant.
- [ ] Keyboard navigation and focus trapping work for user campaign modal, admin shell preview, and crop modal.
- [ ] Browser verification captures desktop and mobile screenshots for user modal, setup slide, standard slide, admin workbench, and crop modal.
- [ ] Unit/integration test coverage passes for campaign services, APIs, preferences, analytics, validation, localization key parity, and user state.
- [ ] The feature has no demo-only placeholders, no hardcoded campaign content shown to users, and no unpublished assets visible to ordinary users.

## Blocked by

- Issues 1-8.
