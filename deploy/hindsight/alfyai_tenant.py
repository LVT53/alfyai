"""AlfyAI server-to-server tenant routing using Hindsight's supported extension API.

No person identifier, authorization decision from a browser, or memory logic lives here.
Only AlfyAI holds signing keys. Tokens bind a canonical opaque UUID to a key version.
"""
import asyncio
import hashlib
import hmac
import json
import re
import uuid
import asyncpg

from hindsight_api.extensions.tenant import AuthenticationError, Tenant, TenantContext, TenantExtension

SCHEMA = re.compile(r"^alfyai_t_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$")

class AlfyTenant(TenantExtension):
    def __init__(self, config):
        super().__init__(config)
        keys = json.loads(config.get("master_keys", "{}"))
        if not isinstance(keys, dict) or not keys:
            raise ValueError("A nonempty versioned tenant keyring is required")
        self.keys = {}
        for version, key in keys.items():
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,24}", version) or not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{64}", key):
                raise ValueError("Tenant keyring requires version names and 256-bit hexadecimal keys")
            self.keys[version] = bytes.fromhex(key)
        self.initialized = set()
        self.provision_lock = asyncio.Lock()

    async def authenticate(self, context):
        try:
            version, tenant, signature = (context.api_key or "").split(".")
            if str(uuid.UUID(tenant)) != tenant or not re.fullmatch(r"[0-9a-f]{64}", signature):
                raise ValueError()
            key = self.keys[version]
        except (ValueError, KeyError, AttributeError):
            raise AuthenticationError("Invalid tenant credential") from None
        expected = hmac.new(key, f"{version}.{tenant}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise AuthenticationError("Invalid tenant credential")
        schema = "alfyai_t_" + tenant.replace("-", "_")
        # Native migration uses advisory locks across processes. This lock avoids
        # redundant migrations on concurrent first requests within one worker.
        async with self.provision_lock:
            if schema not in self.initialized:
                await self.context.run_migration(schema)
                self.initialized.add(schema)
        context.api_key_id = hashlib.sha256(context.api_key.encode()).hexdigest()[:16]
        return TenantContext(schema_name=schema)

    async def list_tenants(self):
        # Discovery also runs before the engine pool exists and from the admin
        # CLI without an ExtensionContext. Never recursively initialize the engine.
        engine = self.context.get_memory_engine() if self._context else None
        pool = getattr(engine, "_pool", None)
        query = "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'alfyai_t_%'"
        if pool is not None:
            async with pool.acquire() as connection:
                rows = await connection.fetch(query)
        else:
            from hindsight_api.config import get_config
            from hindsight_api.pg0 import resolve_database_url
            url = getattr(engine, "db_url", None) or await resolve_database_url(get_config().database_url)
            connection = await asyncpg.connect(url)
            try:
                rows = await connection.fetch(query)
            finally:
                await connection.close()
        return [Tenant(schema=row["nspname"]) for row in rows if SCHEMA.fullmatch(row["nspname"])]
