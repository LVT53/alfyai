import asyncio
import hashlib
import hmac
import unittest
from types import SimpleNamespace
from alfyai_tenant import AlfyTenant
from hindsight_api.extensions.tenant import AuthenticationError

TENANT = "a3f54a51-679f-4211-9920-519ec8cb821d"
KEY = "ab" * 32
def token(tenant=TENANT, version="v1", key=KEY):
    body = f"{version}.{tenant}"
    return body + "." + hmac.new(bytes.fromhex(key), body.encode(), hashlib.sha256).hexdigest()

class TenantTests(unittest.IsolatedAsyncioTestCase):
    async def test_authentication_provisions_once_and_rejects_forgery(self):
        extension = AlfyTenant({"master_keys": '{"v1":"' + KEY + '"}'})
        calls = []
        async def migrate(schema):
            calls.append(schema)
            await asyncio.sleep(0)
        extension.set_context(SimpleNamespace(run_migration=migrate))
        results = await asyncio.gather(*[extension.authenticate(SimpleNamespace(api_key=token())) for _ in range(6)])
        self.assertEqual(len(calls), 1)
        self.assertEqual(results[0].schema_name, "alfyai_t_" + TENANT.replace("-", "_"))
        for forged in [token().replace("821d", "821e"), token(version="missing"), "v1.x';drop.schema", token(key="cd"*32), ""]:
            with self.assertRaises(AuthenticationError):
                await extension.authenticate(SimpleNamespace(api_key=forged))

    async def test_rotation_accepts_only_configured_versions(self):
        extension = AlfyTenant({"master_keys": '{"v2":"' + KEY + '"}'})
        async def migrate(_): pass
        extension.set_context(SimpleNamespace(run_migration=migrate))
        with self.assertRaises(AuthenticationError):
            await extension.authenticate(SimpleNamespace(api_key=token()))
        await extension.authenticate(SimpleNamespace(api_key=token(version="v2")))

    def test_rejects_weak_and_malformed_master_configuration(self):
        for keys in ['{}', '{"v1":"short"}', '{"bad.version":"' + KEY + '"}']:
            with self.assertRaises(ValueError):
                AlfyTenant({"master_keys": keys})

if __name__ == "__main__": unittest.main()
