"""Generate default versioned tenant master keys and private admission secrets.

Use --static-tenant only for compatibility with the bundled static extension.

Does not read an application database, enroll accounts, restart services or migrate data.
Files are never overwritten; retain the old keys when extending the deployment.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import uuid
from urllib.parse import quote

def write_bindings(tenant_ids: list[str], directory: Path) -> None:
    if not tenant_ids or len(set(tenant_ids)) != len(tenant_ids):
        raise ValueError("Supply distinct opaque tenant UUIDs")
    for tenant in tenant_ids:
        if str(uuid.UUID(tenant)) != tenant:
            raise ValueError("Supply canonical opaque tenant UUIDs")
    keys = {tenant: secrets.token_urlsafe(48) for tenant in tenant_ids}
    write_bundle(directory, ["HINDSIGHT_TENANT_KEYS='" + json.dumps(keys, separators=(",", ":")) + "'\n",
                "HINDSIGHT_API_TENANT_USERS=" + ",".join(f"t_{tenant}:{key}" for tenant, key in keys.items()) + "\n"])

def write_master_bindings(directory: Path) -> None:
    master = json.dumps({"v1": secrets.token_hex(32)}, separators=(",", ":"))
    admission = secrets.token_urlsafe(48)
    inference = secrets.token_urlsafe(48)
    write_bundle(directory, [
        f"HINDSIGHT_TENANT_MASTER_KEYS='{master}'\nHINDSIGHT_TENANT_ACTIVE_KEY=v1\nHINDSIGHT_ADMISSION_KEY={admission}\nHINDSIGHT_OVERNIGHT_IDLE=false\n",
        f"HINDSIGHT_API_TENANT_MASTER_KEYS='{master}'\nHINDSIGHT_API_HTTP_ACTIVITY_KEY={admission}\nHINDSIGHT_API_HTTP_INFERENCE_KEY={inference}\nHINDSIGHT_API_LLM_API_KEY={inference}\n"
    ])

def write_bundle(directory: Path, contents: list[str]) -> None:
    # Generated secrets are dotenv-safe. Keep separate raw and URI fields so
    # Postgres receives the literal password and the URI decodes to that value.
    password = secrets.token_urlsafe(48)
    contents = [*contents, f"HINDSIGHT_DB_PASSWORD='{password}'\nHINDSIGHT_DB_PASSWORD_URI='{quote(password, safe='')}'\n"]
    targets = [directory / name for name in ("alfyai-tenants.env", "native-tenants.env", "native-db.env")]
    if any(path.exists() for path in targets):
        raise FileExistsError("Secret files already exist; do not rotate existing bindings accidentally")
    directory.mkdir(parents=True, exist_ok=True)
    created = []
    try:
        for target, content in zip(targets, contents):
            descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            created.append(target)
            with os.fdopen(descriptor, "w") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
    except BaseException:
        for target in created:
            target.unlink(missing_ok=True)
        raise

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--static-tenant", action="append", default=[])
    args = parser.parse_args()
    write_bindings(args.static_tenant, args.output) if args.static_tenant else write_master_bindings(args.output)
    print("Created three mode-0600 tenant and database configuration files; no service or account was changed.")
