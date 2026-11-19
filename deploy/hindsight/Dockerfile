FROM python:3.12-slim-bookworm
ARG HINDSIGHT_COMMIT=9fb28dbd724dc1ce4da7cb4c49008e601db76c5f
RUN test "$HINDSIGHT_COMMIT" = 9fb28dbd724dc1ce4da7cb4c49008e601db76c5f \
 && apt-get update && apt-get install -y --no-install-recommends git libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && git init /opt/hindsight && cd /opt/hindsight \
 && git remote add origin https://github.com/vectorize-io/hindsight.git \
 && git fetch --depth 1 origin "$HINDSIGHT_COMMIT" && git checkout --detach FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$HINDSIGHT_COMMIT" \
 && python -m pip install --no-cache-dir './hindsight-api-slim[local-onnx]' flashrank \
 && mkdir /opt/extensions \
 && cp -R hindsight-extensions/static-keys-tenant/hindsight_ext_static_keys_tenant /opt/extensions/ \
 && git rev-parse HEAD > /opt/extensions/engine-commit
COPY alfyai_http.py alfyai_tenant.py alfyai_admission.py /opt/extensions/
ENV PYTHONPATH=/opt/extensions \
    HINDSIGHT_API_TENANT_EXTENSION=alfyai_tenant:AlfyTenant \
    HINDSIGHT_API_HTTP_EXTENSION=alfyai_http:AlfyIdentity \
    HINDSIGHT_API_LLM_MAX_CONCURRENT=1 \
    HINDSIGHT_API_LLM_TRACE_ENABLED=false \
    HINDSIGHT_API_LLM_TRACE_DELETE_WITH_DOCUMENT=true \
    HINDSIGHT_API_OTEL_TRACES_ENABLED=false \
    HINDSIGHT_API_LOG_LEVEL=warning
RUN python -c 'import hindsight_ext_static_keys_tenant, alfyai_http'
RUN useradd --create-home --uid 10001 hindsight
USER hindsight
EXPOSE 8888
CMD ["hindsight-api", "--host", "0.0.0.0", "--port", "8888", "--workers", "1"]
