"""Read counts only, for the runner's own synthetic tenant and retired banks."""
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import UUID

record = json.loads(Path(sys.argv[1]).read_text())
owner = str(UUID(record["userId"]))
assert record["mode"] == "privacy"
reset = next(step for step in record["steps"] if step["name"] == "reset-during-native-retain")
scope = next(step for step in record["steps"] if step["name"] == "scope-isolation")
tenant = str(UUID(next(account["tenantId"] for account in scope["accounts"] if account["userId"] == owner)))
schema = "alfyai_t_" + tenant.replace("-", "_")
banks = [str(UUID(item["id"])) for item in reset["physical"]]
assert len(banks) == 3 and set(banks) == {bank["bank"]["id"] for bank in scope["banks"]}
root = Path("/tmp/alfyai-hindsight-eval")
meta = json.loads((root / "pg0/instances/alfyai-native-lifecycle-acceptance-20261118/instance.json").read_text())
exe = root / f"pg-install/{meta['version']}/bin/psql"

def query(text):
    return subprocess.check_output(
        [str(exe), "-X", "-w", "-h", "127.0.0.1", "-p", str(meta["port"]),
         "-U", meta["username"], "-d", meta["database"], "-Aqt", "-v", "ON_ERROR_STOP=1", "-c", text],
        env={**os.environ, "PGPASSWORD": meta["password"], "PGOPTIONS": "-c default_transaction_read_only=on"},
        text=True,
    ).splitlines()

tables = query(f"select table_name from information_schema.columns where table_schema='{schema}' and column_name='bank_id' order by table_name")
assert set(tables) >= {"banks", "documents", "chunks", "memory_units", "invalidated_memory_units"}
ids = ",".join(f"'{bank}'" for bank in banks)
counts = {}
for table in tables:
    assert table.isidentifier()
    raw, = query(f'SELECT count(*) FROM "{schema}"."{table}" WHERE bank_id IN ({ids})')
    counts[table] = int(raw)
print(json.dumps({"tenant": tenant, "banks": banks, "postgresPid": meta["pid"], "counts": counts}, indent=2))
