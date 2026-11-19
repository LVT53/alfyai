import os
from pathlib import Path
root=Path('/tmp/alfyai-hindsight-eval')
settings={'PG0_HOME':str(root/'pg0'),'PG0_INSTALLATION_DIR':str(root/'pg-install'),'HF_HOME':str(root/'hf'),'HINDSIGHT_API_DATABASE_URL':os.getenv('ALFYAI_NATIVE_DATABASE_URL', 'pg0://alfyai-memory-acceptance-v2'),'HINDSIGHT_API_LLM_PROVIDER':'openai','HINDSIGHT_API_LLM_MODEL':'qwen3-6-27b','HINDSIGHT_API_LLM_API_KEY':'synthetic-local-proxy','HINDSIGHT_API_LLM_BASE_URL':'http://127.0.0.1:18891/v1','HINDSIGHT_API_EMBEDDINGS_PROVIDER':'onnx','HINDSIGHT_API_RERANKER_PROVIDER':'flashrank','HINDSIGHT_API_RERANKER_FLASHRANK_MODEL':'ms-marco-MultiBERT-L-12','HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR':str(root/'reranker')}
settings.update({'HINDSIGHT_API_TENANT_EXTENSION':'alfyai_tenant:AlfyTenant','HINDSIGHT_API_TENANT_USERS':','.join(f't_a3f54a51-679f-4211-9920-519ec8cb821{i}:synthetic-acceptance-{i}' for i in range(2)),'HINDSIGHT_API_TENANT_SCHEMA_PREFIX':'alfyai','PYTHONPATH':str(root/'source/hindsight-extensions/static-keys-tenant')})
settings['HINDSIGHT_API_HTTP_EXTENSION']='alfyai_http:AlfyIdentity'
settings['PYTHONPATH']=str(Path.cwd()/'deploy/hindsight')+':'+settings['PYTHONPATH']
settings['HINDSIGHT_API_RETAIN_LLM_EXTRA_BODY']='{"chat_template_kwargs":{"enable_thinking":true},"max_tokens":8192}'
settings['HINDSIGHT_API_LLM_MAX_CONCURRENT']='6'
settings['HINDSIGHT_API_SKIP_LLM_VERIFICATION']='true'
settings['HINDSIGHT_API_LLM_BASE_URL']='http://127.0.0.1:18890/ext/alfyai/inference/v1'
settings['HINDSIGHT_API_LLM_API_KEY']='synthetic-admission'
settings['HINDSIGHT_API_HTTP_INFERENCE_KEY']='synthetic-admission'
settings['HINDSIGHT_API_HTTP_UPSTREAM_URL']='http://127.0.0.1:18891/v1'
settings['HINDSIGHT_API_HTTP_UPSTREAM_KEY']='synthetic-local-proxy'
settings['HINDSIGHT_API_HTTP_UPSTREAM_MODEL']='qwen3-6-27b'
settings['HINDSIGHT_API_HTTP_ACTIVITY_URL']='http://127.0.0.1:18892/api/internal/memory-admission'
settings['HINDSIGHT_API_HTTP_ACTIVITY_KEY']='synthetic-activity'
settings['HINDSIGHT_API_TENANT_MASTER_KEYS']='{"synthetic":"'+'ab'*32+'","synthetic-v2":"'+'cd'*32+'"}'
settings['HINDSIGHT_API_LLM_TRACE_ENABLED']='false'
settings['HINDSIGHT_API_LLM_TRACE_DELETE_WITH_DOCUMENT']='true'
settings['HINDSIGHT_API_OTEL_TRACES_ENABLED']='false'
settings['HINDSIGHT_API_LOG_LEVEL']='warning'
os.environ.update(settings)
cmd=str(root/'venv/bin/hindsight-api')
os.execv(cmd,[cmd,'--host','127.0.0.1','--port','18890'])
