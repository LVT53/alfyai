# Staging runner model metadata: least-privilege addendum

Status: independent design judge PASS (Descartes); implementation review pending. Scope: `verify-contract.mjs`, its focused integration tests, this addendum and the Task4 report. No app route, authentication, account-role, model policy or deployment change.

## Problem and decision

The normal synthetic test account can list enabled composite IDs through `/api/models`, but cannot read canonical provider model names through the admin model endpoint. The first staging matrix stopped during startup with zero generations; a generic setup error obscured the failed endpoint. Public display names cannot substitute for canonical names.

Add `--model-metadata-json FILE`, an explicitly trusted, operator-supplied read-only **stage DB export**. With this flag, the runner must never request an admin endpoint, including on validation failure. Continue to authenticate as the normal test account and check `/api/models`. Without the flag, retain the existing admin-metadata startup path for an already-authorized admin account; do not elevate an account, change auth, or fall back automatically between paths.

## Export contract and trust boundary

The proposed JSON shape is:

```json
{
  "version": 1,
  "source": "stage-db-readonly",
  "base": "https://ai.dev.alfydesign.com",
  "models": [
    {
      "providerId": "68d77707-6ace-4e55-8eee-a8ff49e7fec3",
      "modelId": "5b03df4e-1144-465e-ab7e-d8a40f8c70c6",
      "name": "deepseek-flash"
    }
  ]
}
```

The example shows one family; the export must cover every family selected by `--families`. The controller gathers authoritative rows using a read-only stage query constrained to the fixed matrix's exact provider/model pairs. No credentials, provider URLs/keys, prompts, user data or broad DB export belong in this file. The runner does not execute SQL or fetch this file remotely.

Validate version, exact permitted keys/types, literal `source: "stage-db-readonly"`, canonical stage `base: "https://ai.dev.alfydesign.com"`, nonempty rows and unique model pairs. Validate **every supplied row** against the fixed matrix's exact provider ID, model UUID and canonical name; reject unsupported, contradictory, duplicate or missing selected bindings. Unselected rows are allowed only when they independently match another fixed matrix member. No display-name matching, aliases, heuristic family inference, rebind, DeepSeek pro substitution or fallback-policy changes.

This file is an operator trust input, not a cryptographic DB attestation. Source/base declarations cannot independently prove origin, release freshness or that the remote database still matches. Record validated version/source/base and SHA-256 of the bytes in the partial/final report to identify the exact trusted input; never record its filesystem path or arbitrary parsed content. The controller independently binds the read-only query to the deployed stage release (currently reported `b5599daad`) before running. No self-declared revision is needed in this minimal artifact, and no claim that a file declaration verifies the live deployment. For permitted loopback staging access on port3002, the export still names the canonical public stage base; never a production or arbitrary export base.

## Exact read-only export query for the controller

Run against the controller-selected **stage** DB with SQLite read-only mode; this worker does not execute it. The following emits the full minimal JSON artifact directly. Scope is three exact pairs, selecting only their IDs and canonical names from the actual `provider_models` schema:

```sql
SELECT json_object(
  'version', 1,
  'source', 'stage-db-readonly',
  'base', 'https://ai.dev.alfydesign.com',
  'models', json_group_array(json_object(
    'providerId', provider_id, 'modelId', id, 'name', name
  ))
)
FROM (
  SELECT provider_id, id, name FROM provider_models
  WHERE (provider_id='68d77707-6ace-4e55-8eee-a8ff49e7fec3' AND id='5b03df4e-1144-465e-ab7e-d8a40f8c70c6')
     OR (provider_id='901b7294-cf08-441b-a8e0-46494bc28145' AND id='7a511b91-39bf-4f58-8eb3-aa9500c19b05')
     OR (provider_id='7107c713-f6ff-483b-aba3-72556d569949' AND id='c45389f7-2daa-4911-8da9-b679f7657089')
  ORDER BY provider_id, id
);
```

Expected names respectively: `deepseek-flash`, `accounts/fireworks/models/kimi-k3p1-pro`, `qwen3-6-27b`. Query output with fewer rows is not accepted for the full matrix. `sqlite3 -readonly <controller-selected-stage-db> <query>` is illustrative invocation only; no DB path, credentials or remote execution is inferred here.

## Startup and durable validation

1. Validate CLI/staging target and initialize the partial report. Read/validate the local metadata file, if supplied, before login or generation. Failure is terminal; no fallback admin request.
2. Login with the existing synthetic account. Require every selected **exact composite ID** in the normal account's enabled `/api/models` listing, regardless of metadata source. A file cannot enable a disabled/inaccessible model or authorize generation.
3. Resolve canonical startup bindings from the validated export, or the existing admin model endpoint when the file flag is absent. Both paths enforce the same fixed matrix policy before any conversation creation/generation.
4. Run the existing serial known-answer scenarios. Preserve request IDs, structural/plain/SSE parity, saved-message/receipt agreement, partial-report-on-first-failure, and unchanged cleanup.
5. Preserve mandatory independent exact-generated-ID audit: every working/failed/closing attempt must match requested provider/model/canonical-name policy, usage and durable outcomes. The trusted startup export cannot replace, satisfy or weaken this audit. HTTP success remains exit3/audit pending; full acceptance still requires offline exact-ID audit.

## Safe setup diagnostics

Track a fixed setup phase (`metadata-file`, `login`, `public-models`, `model-bindings`) and persist a bounded diagnostic on failure: phase, allowlisted code, optional family, optional HTTP status, and static operator guidance. Never persist raw exception messages, HTTP bodies, headers, cookies, credentials, prompts, file paths or unknown metadata fields.

Examples: `metadata-file / invalid-model-metadata`; `public-models / selected-model-unavailable`; `model-bindings / admin-metadata-unavailable / HTTP500`, with guidance to supply an authoritative stage export for a normal account. A masked500 must be reported as observed500, not guessed to prove an underlying403. Transport/JSON failures get safe static codes. Preserve existing generic handling outside the bounded setup phases. Failed startup persists zero scenario records and performs zero conversation creation/generation.

## Focused TDD acceptance

Before implementation, add synthetic offline regressions that demonstrate current rejection of the new flag / missing file-path support and missing setup diagnostics. Then prove:

- Valid stage export + matching public IDs works for a normal synthetic login; mocked requests assert **zero admin calls** and stop before any real generation.
- Wrong/production source, wrong canonical name/provider/model ID, duplicate/unsupported row, missing selected row, unknown fields, unreadable/malformed file all fail closed; no admin fallback or generation.
- Correct metadata + absent public ID still fails before conversation creation/generation.
- Absent flag retains the existing admin path and exact canonical-name checks; denied/masked500 produces safe phase/status/guidance in the partial report.
- Secret-like sentinel strings in malformed metadata, paths, response bodies and thrown errors never appear in captured diagnostics/report/console output.
- Existing every-attempt actual-name, model-substitution, receipt/saved/audit identity, known-answer and audit-pending regressions remain unchanged and passing.

Run only focused Vitest and scoped formatting/checks permitted by the controller, Node22 with login:false. No gates, browser/build, deployment, remote execution or real model calls in this authoring task. Controller supplies the authoritative export and coordinates the independent judge before implementation proceeds.
