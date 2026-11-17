#!/usr/bin/env python3
"""
Direct zero-Vercel deployment pipeline:
Builds DOMATION_LANDINGPAGE frontend + bundles AUTO_DATA_TENANRT backend
and pushes directly to AZDIGI (https://data.domation.net) over SSH.

Usage:
  python scripts/deploy-direct.py                  # Build & deploy code + dist (preserves prod DB & .env)
  python scripts/deploy-direct.py --install        # Also run npm install --omit=dev on server
  python scripts/deploy-direct.py --with-env       # Also sync .env to production
  python scripts/deploy-direct.py --with-db        # Also upload local .autodata-pgdata (backs up remote first)
  python scripts/deploy-direct.py --skip-build     # Skip local frontend/backend build steps
  python scripts/deploy-direct.py --dry-run        # Show archive plan without uploading
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT_BACKEND = Path(__file__).resolve().parent.parent
DEFAULT_FRONTEND_ROOT = ROOT_BACKEND.parent / "DOMATION_LANDINGPAGE"
ROOT_FRONTEND = Path(os.environ.get("DOMATION_FRONTEND_DIR", str(DEFAULT_FRONTEND_ROOT)))

REMOTE_HOST = os.environ.get("AUTODATA_SSH_HOST", "vhvxoigh@chiefaiofficer.vn")
REMOTE_PORT = os.environ.get("AUTODATA_SSH_PORT", "2210")
REMOTE_DIR = os.environ.get("AUTODATA_REMOTE_DIR", "/home/vhvxoigh/data.domation.net")
PROD_URL = os.environ.get("AUTODATA_PROD_URL", "https://data.domation.net")

EXCLUDE_DIST_TOP = {"CHIA DATA", "ERP-Product", "crm_imgs", "meta"}


def run_step(cmd: list[str], cwd: Path | None = None, shell: bool = False) -> None:
    label = " ".join(cmd) if isinstance(cmd, list) else str(cmd)
    print(f"\n==> {label}")
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=True, shell=shell)


def load_local_env(path: Path) -> dict[str, str]:
    vals: dict[str, str] = {}
    if not path.exists():
        return vals
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals


def build_artifacts() -> None:
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    node_cmd = "node.exe" if os.name == "nt" else "node"

    if ROOT_FRONTEND.exists():
        run_step([npm_cmd, "run", "build"], cwd=ROOT_FRONTEND)
    else:
        print(f"WARN: Frontend directory not found at {ROOT_FRONTEND}; reusing backend only.")

    run_step([npm_cmd, "run", "typecheck"], cwd=ROOT_BACKEND)
    bundle_js = (
        "import esbuild from 'esbuild'; "
        "esbuild.buildSync({ entryPoints: ['server/index.ts'], bundle: true, platform: 'node', "
        "target: 'node22', format: 'esm', packages: 'external', outfile: 'dist-server/index.mjs', sourcemap: false }); "
        "console.log('Bundled dist-server/index.mjs');"
    )
    run_step([node_cmd, "--input-type=module", "-e", bundle_js], cwd=ROOT_BACKEND)


def create_deploy_archive(with_db: bool, full_dist: bool) -> tuple[Path, int]:
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tf:
        archive_path = Path(tf.name)

    file_count = 0
    with tarfile.open(archive_path, "w:gz") as tar:
        for fname in ["package.json", "package-lock.json", "app.cjs", "app.js", ".htaccess", "tsconfig.server.json"]:
            p = ROOT_BACKEND / fname
            if p.exists():
                tar.add(p, arcname=fname)
                file_count += 1

        dirs_to_pack = ["dist-server", "server", "scripts"]
        if with_db:
            dirs_to_pack.append(".autodata-pgdata")

        for dname in dirs_to_pack:
            base = ROOT_BACKEND / dname
            if not base.exists():
                continue
            for sub in base.rglob("*"):
                if sub.name == "postmaster.pid":
                    continue
                rel = sub.relative_to(ROOT_BACKEND).as_posix()
                info = tar.gettarinfo(str(sub), arcname=rel)
                if sub.suffix == ".sh":
                    info.mode = 0o755
                if sub.is_file():
                    with sub.open("rb") as f:
                        tar.addfile(info, f)
                    file_count += 1
                else:
                    tar.addfile(info)

        dist_dir = ROOT_FRONTEND / "dist"
        if dist_dir.exists():
            for sub in dist_dir.rglob("*"):
                rel_parts = sub.relative_to(dist_dir).parts
                if not full_dist and rel_parts and rel_parts[0] in EXCLUDE_DIST_TOP:
                    continue
                arcname = "dist/" + sub.relative_to(dist_dir).as_posix()
                info = tar.gettarinfo(str(sub), arcname=arcname)
                if sub.is_file():
                    with sub.open("rb") as f:
                        tar.addfile(info, f)
                    file_count += 1
                else:
                    tar.addfile(info)

    return archive_path, file_count


def upload_and_restart(archive_path: Path, install_deps: bool, with_db: bool, with_env: bool) -> None:
    remote_cmds = [
        f"mkdir -p {REMOTE_DIR}/tmp",
        f"rm -rf {REMOTE_DIR}/dist",
    ]
    if with_db:
        remote_cmds.extend([
            f"rm -rf {REMOTE_DIR}/.autodata-pgdata.bak",
            f"( [ -d {REMOTE_DIR}/.autodata-pgdata ] && mv {REMOTE_DIR}/.autodata-pgdata {REMOTE_DIR}/.autodata-pgdata.bak || true )",
        ])

    remote_cmds.append(f"tar -xzf - -C {REMOTE_DIR}")
    remote_cmds.append(f"chmod 755 {REMOTE_DIR}/scripts/run-master-cron.sh")
    if with_db:
        remote_cmds.append(f"chmod 700 {REMOTE_DIR}/.autodata-pgdata")
    if install_deps:
        remote_cmds.append(
            f"export PATH=/opt/alt/alt-nodejs22/root/usr/bin:/usr/local/bin:/usr/bin:/bin && "
            f"cd {REMOTE_DIR} && npm install --omit=dev --no-audit --no-fund"
        )
    remote_cmds.append(f"touch {REMOTE_DIR}/.htaccess {REMOTE_DIR}/tmp/restart.txt")

    ssh_cmd = [
        "ssh", "-4", "-p", REMOTE_PORT, "-o", "BatchMode=yes", REMOTE_HOST,
        " && ".join(remote_cmds),
    ]
    print(f"\n==> Uploading archive to {REMOTE_HOST}:{REMOTE_DIR} ...")
    with archive_path.open("rb") as fh:
        res = subprocess.run(ssh_cmd, stdin=fh)
    if res.returncode != 0:
        raise RuntimeError(f"SSH upload failed with exit code {res.returncode}")

    if with_env:
        env_vals = load_local_env(ROOT_BACKEND / ".env")
        prod_env_lines = [
            "PORT=3100",
            "NODE_ENV=production",
            f"DATABASE_URL={env_vals.get('DATABASE_URL', '')}",
            "PGLITE_DATA_DIR=./.autodata-pgdata",
            f"JWT_SECRET={env_vals.get('JWT_SECRET', '')}",
            f"PLATFORM_JWT_SECRET={env_vals.get('PLATFORM_JWT_SECRET', '')}",
            f"CRON_SECRET={env_vals.get('CRON_SECRET', env_vals.get('PLATFORM_JWT_SECRET', ''))}",
            f"VAULT_MASTER_SECRET={env_vals.get('VAULT_MASTER_SECRET', '')}",
            f"SUPERADMIN_EMAIL={env_vals.get('SUPERADMIN_EMAIL', 'ops-admin@autodata.vn')}",
            f"SUPERADMIN_PASSWORD={env_vals.get('SUPERADMIN_PASSWORD', '')}",
            f"TELEGRAM_BOT_TOKEN={env_vals.get('TELEGRAM_BOT_TOKEN', '')}",
            f"TELEGRAM_CHAT_ID={env_vals.get('TELEGRAM_CHAT_ID', '')}",
            "TELEGRAM_SILENT_MODE=false",
            "OUTBOUND_SILENT_MODE=false",
            "MIGRATION_SILENT_MODE=false",
            f"GOOGLE_CLIENT_ID={env_vals.get('GOOGLE_CLIENT_ID', '')}",
        ]
        env_payload = "\n".join(prod_env_lines) + "\n"
        res_env = subprocess.run(
            ["ssh", "-4", "-p", REMOTE_PORT, "-o", "BatchMode=yes", REMOTE_HOST,
             f"cat > {REMOTE_DIR}/.env && chmod 600 {REMOTE_DIR}/.env && touch {REMOTE_DIR}/tmp/restart.txt"],
            input=env_payload,
            text=True,
        )
        if res_env.returncode != 0:
            raise RuntimeError(f"Syncing .env failed with exit code {res_env.returncode}")


def verify_live() -> None:
    print(f"\n==> Verifying {PROD_URL} ...")
    for path in ["/api/v1/health", "/api/autodata?action=bootstrap", "/ecolife"]:
        req = urllib.request.Request(f"{PROD_URL}{path}", headers={"Accept": "text/html,application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"  OK {resp.status} {PROD_URL}{path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Direct SSH deploy to data.domation.net (no Vercel).")
    parser.add_argument("--skip-build", action="store_true", help="Skip frontend vite build and backend typecheck/esbuild")
    parser.add_argument("--install", action="store_true", help="Run npm install --omit=dev on server")
    parser.add_argument("--with-db", action="store_true", help="Also sync local .autodata-pgdata to server")
    parser.add_argument("--with-env", action="store_true", help="Also overwrite remote .env from local .env")
    parser.add_argument("--full-dist", action="store_true", help="Include non-AutoData showcase subfolders from dist/")
    parser.add_argument("--dry-run", action="store_true", help="Build archive locally and print summary without uploading")
    args = parser.parse_args()

    if not args.skip_build:
        build_artifacts()

    archive_path, file_count = create_deploy_archive(with_db=args.with_db, full_dist=args.full_dist)
    size_mb = archive_path.stat().st_size / (1024 * 1024)
    print(f"\nPrepared archive: {archive_path} ({size_mb:.2f} MB, {file_count} entries)")

    try:
        if args.dry_run:
            print("DRY-RUN mode: skipping SSH upload.")
            return 0
        upload_and_restart(archive_path, install_deps=args.install, with_db=args.with_db, with_env=args.with_env)
        verify_live()
        print("\nDEPLOY_DIRECT_COMPLETE")
        return 0
    finally:
        if archive_path.exists():
            archive_path.unlink()


if __name__ == "__main__":
    raise SystemExit(main())
