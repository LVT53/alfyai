# Native extraction preview on isolated staging

On 19 November 2026, the TypeScript Hindsight client sent one synthetic two-fact utterance through the isolated GPU staging engine using an explicitly configured disposable bank. The authenticated capability response matched engine commit `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`, tenant binding and extension identity. The running native image was `sha256:50f9dfcdfa094720d99d5d95f74a50c1c77655291085da63e69729941788f762`. The private gateway used the local `qwen3-6-27b` alias. Native request traces and OpenTelemetry traces were off.

The app client verified the bank configuration and checked the source fence once immediately before the preview request. The request carried a single text source and its original timestamp. The response contained two attributable draft facts. Both expected synthetic details appeared. The returned draft array had SHA-256 `e72a13bf0f12df878860fc1e26e4ba4eaea58d81a9216d095a195f1c067aa5b5`.

| Observation | Before preview | After preview |
| --- | ---: | ---: |
| Bank rows | 1 | 1, identical row digest |
| Documents | 0 | 0 |
| Current facts and archived facts | 0 | 0 |
| Stored fact embeddings | 0 | 0 |
| Gateway completions | 96 | 97 |
| Gateway rejections | 22 | 22 |
| GPU embedding requests | 242 | 242 |
| GPU reranking requests | 59 | 59 |

Gateway accumulated inference time increased by 3,687 ms. The bank returned an empty native fact list and no pending operations after preview. Tenant authentication created the initially absent synthetic schema for setup. The synthetic bank was then deleted and all scoped data counts returned zero. The empty synthetic schema remained. This exercise made no production requests and used no account history.

The wire tests cover attested tenant and bank configuration, the exact private POST and authorization header, the disabled flag, rejection by the final fence, and malformed, unattributed and oversized responses. The implementation used the pinned staging OpenAPI document and installed engine source to verify the request fields, native enable flag, chunk attribution and extraction-only call. [Upstream Hindsight API reference](https://hindsight.vectorize.io/api-reference) · [Vitest mocking reference](https://vitest.dev/api/vi)
