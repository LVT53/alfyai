"""Content-free build/extension identity; no custom extraction or storage operations."""
import hashlib
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException
from hindsight_api.extensions.http import HttpExtension
from hindsight_api.models import RequestContext
from hindsight_api.extensions.tenant import AuthenticationError

ENGINE_COMMIT = "9fb28dbd724dc1ce4da7cb4c49008e601db76c5f"

class AlfyIdentity(HttpExtension):
    def get_router(self, memory):
        router = APIRouter()
        from alfyai_admission import install_admission
        install_admission(router, self.config)

        @router.get("/alfyai/capabilities")
        async def capabilities(authorization: str = Header(default="")):
            if not authorization.startswith("Bearer "):
                raise HTTPException(401, "Authentication required")
            try:
                tenant = await memory.tenant_extension.authenticate(RequestContext(api_key=authorization[7:]))
            except AuthenticationError:
                raise HTTPException(401, "Authentication required") from None
            identity = Path(__file__).with_name("engine-commit").read_text().strip()
            if identity != ENGINE_COMMIT:
                raise HTTPException(503, "Engine build mismatch")
            return {"engine_commit": identity, "extension": "alfyai-identity-v1",
                    "tenant_extension": type(memory.tenant_extension).__name__,
                    "tenant_binding": hashlib.sha256(tenant.schema_name.encode()).hexdigest()}
        return router
