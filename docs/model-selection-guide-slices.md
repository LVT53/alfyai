# Model Selection Guide Slices

Parent: Local product discussion, 2026-06-15. Domain terms are captured in [CONTEXT.md](../CONTEXT.md) under Model Provider Context.

This document breaks the Model Selection Guide work into independently grabbable tracer-bullet slices. Each slice should leave the app in a stable, demoable state and should preserve the existing model selector as the only model-selection surface.

## Approved Breakdown

1. **Provider Processing Region Cues**
   - **Type**: AFK
   - **Blocked by**: None
   - **User stories covered**: Users can see a compact processing-region flag in model-selection UI; admins can maintain the provider region and privacy policy link.

2. **Model Guidance Authoring Metadata**
   - **Type**: AFK
   - **Blocked by**: None
   - **User stories covered**: Admins can maintain short per-model guidance notes and optional UI-only guide badges.

3. **Model Selection Guide Modal**
   - **Type**: AFK
   - **Blocked by**: Slices 1, 2
   - **User stories covered**: Users can open a compact informational modal from the model selector and compare all enabled models without changing the active model.

4. **Scale, Accessibility, And Visual Review**
   - **Type**: HITL
   - **Blocked by**: Slice 3
   - **User stories covered**: The guide remains readable and polished with at least a dozen enabled models on desktop and mobile.

## Issue 1: Provider Processing Region Cues

## What to build

Add **Provider Processing Region** and **Provider Privacy Policy Link** as admin-maintained provider metadata, then surface the processing-region cue in the existing model selector without changing the selector's behavior.

The compact selector should remain focused on choosing a model. In tight UI, the processing region is shown as a flag-only cue with the full country or region name available on hover or focus. The privacy policy link is saved for later use in the Model Selection Guide and should not clutter the selector dropdown.

## Acceptance criteria

- [ ] Admins can save an optional Provider Processing Region for a Model Provider.
- [ ] Admins can save an optional Provider Privacy Policy Link for a Model Provider.
- [ ] Provider validation rejects malformed privacy policy URLs while allowing the field to remain blank.
- [ ] The existing model selector keeps its current selection behavior and layout.
- [ ] Provider rows in the selector can show a compact flag cue when a processing region is configured.
- [ ] Hover or focus on the processing-region cue exposes the full country or region name.
- [ ] The selector does not show provider privacy policy links, provider base URLs, API-key details, or other third-party provider configuration.
- [ ] EN/HU strings cover region labels, privacy-policy labels, validation errors, and accessible names.
- [ ] Tests cover provider metadata persistence, admin update validation, model API projection, and selector rendering.

## Blocked by

None - can start immediately.

## Issue 2: Model Guidance Authoring Metadata

## What to build

Add **Model Guidance Authoring** fields to Provider Model administration. Admins should be able to save a short localized **Model Guidance Note** and an optional **Model Guide Badge** for each enabled or disabled Provider Model.

The badge is presentation-only and limited to the v1 choices Intelligent and Fast. It must not feed model routing, fallback, context selection, pricing, provider behavior, prompts, or usage accounting.

## Acceptance criteria

- [ ] Admins can save optional English and Hungarian Model Guidance Notes on a Provider Model.
- [ ] Guidance note validation keeps notes short enough for at most a couple lines in the guide.
- [ ] Admins can choose no badge, Intelligent, or Fast for a Provider Model.
- [ ] The Model Guide Badge is persisted as display metadata only.
- [ ] Runtime model execution, fallback, context selection, prompt assembly, and usage accounting do not read or branch on the badge.
- [ ] The existing model selector does not become a second guide surface.
- [ ] EN/HU strings cover guidance-note fields, badge choices, and validation errors.
- [ ] Tests cover admin create/update validation, persistence, API serialization, and absence of runtime coupling.

## Blocked by

None - can start immediately.

## Issue 3: Model Selection Guide Modal

## What to build

Create the **Model Selection Guide** as a contextual informational modal opened by a **Model Guide Launcher** beside the existing model selector trigger. The guide shows every currently enabled Provider Model, grouped by Model Provider, using compact **Model Guide Rows**.

The modal is informational only. It must not allow users to select or change the active model. Users should return to the existing model selector when they want to switch models.

Each Model Guide Row should show the Provider Model identity, provider grouping, processing-region cue, optional UI-only badge, relative **Model Cost Indicator**, notable context capacity when useful, and the short Model Guidance Note when configured. Exact token pricing should be available on hover or focus, not as primary row text. Provider privacy policy links should be available through an unobtrusive icon affordance near the provider heading.

## Acceptance criteria

- [ ] A question-mark Model Guide Launcher appears beside every rendered model selector trigger.
- [ ] Opening the launcher shows the Model Selection Guide modal without opening or changing the selector dropdown.
- [ ] The modal lists all currently enabled Provider Models.
- [ ] Models are grouped by Model Provider and preserve provider display labels.
- [ ] Provider groups show the processing-region flag when configured.
- [ ] Provider groups expose the privacy policy link through an icon affordance when configured.
- [ ] Each row can show the optional Model Guide Badge, relative Model Cost Indicator, notable context capacity, and short guidance note.
- [ ] Exact input/output token prices are available on hover or focus for the cost indicator.
- [ ] Missing guidance notes do not create noisy empty-state text for ordinary users.
- [ ] The modal has no model-select, use-this-model, or active-model-changing action.
- [ ] The existing selector dropdown behavior remains unchanged.
- [ ] EN/HU strings cover launcher labels, modal title, cost labels, tooltip text, privacy-policy affordance, and empty/error states.
- [ ] Tests cover launcher behavior, modal rendering, grouping, all-enabled-model inclusion, non-selection behavior, pricing tooltip text, and privacy-link rendering.

## Blocked by

- Issue 1: Provider Processing Region Cues.
- Issue 2: Model Guidance Authoring Metadata.

## Issue 4: Scale, Accessibility, And Visual Review

## What to build

Harden the Model Selection Guide for real deployment scale and responsive quality. The guide should remain readable with at least a dozen enabled models, preserve compact row density, avoid cramped text, and work on desktop and mobile without turning into an essay-style onboarding or campaign surface.

This slice is HITL because the final density and visual hierarchy need product/design review after implementation screenshots exist.

## Acceptance criteria

- [ ] Desktop verification covers at least twelve enabled Provider Models across multiple providers.
- [ ] Mobile verification covers the same model set without text overlap, clipped controls, or cramped tap targets.
- [ ] Keyboard users can open, navigate, inspect tooltips or equivalent focus text, and close the guide.
- [ ] Screen-reader labels expose the launcher purpose, processing-region full name, cost tooltip details, and privacy-policy affordance.
- [ ] The guide keeps the existing model selector as the only active model-selection surface.
- [ ] The guide avoids long prose, raw capability dumps, fallback policy, provider URLs, API-key details, and other admin/provider configuration.
- [ ] Visual review confirms row density, provider grouping, flag-only compact cue, privacy-link icon placement, and hover/focus affordances.
- [ ] `npm run check` passes with 0 errors and 0 warnings.
- [ ] Fallow is run against the current worktree and any new findings are resolved or justified.

## Blocked by

- Issue 3: Model Selection Guide Modal.
