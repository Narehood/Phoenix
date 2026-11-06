"""Resolve dependency manifests in a guarded, disposable Linux CI checkout."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
if sys.platform != "linux" or not os.environ.get("PHOENIX_OUTPUT") or not os.environ.get("GOCACHE"):
    raise SystemExit("Run dependency refresh through scripts/validate.py in Linux CI.")


def run(command, **kwargs):
    print("+ " + " ".join(command), flush=True)
    return subprocess.run(command, cwd=ROOT, check=True, timeout=180, **kwargs)


before = json.loads((ROOT / "web/package.json").read_text(encoding="utf-8"))
run(["npm", "--prefix", "web", "install", "--package-lock-only", "--ignore-scripts",
     "--no-audit", "--no-fund", "--save-exact", "react@latest", "react-dom@latest"])
run(["npm", "--prefix", "web", "install", "--package-lock-only", "--ignore-scripts",
     "--no-audit", "--no-fund", "--save-dev", "--save-exact", "@types/react@latest",
     "@types/react-dom@latest", "@vitejs/plugin-react@latest", "prettier@latest",
     "typescript@latest", "vite@latest"])
# go get intentionally edits manifests and omits the -mod flag. Retain the
# guard's owned caches, local toolchain, lock and storage limits; only relax
# readonly manifest selection for this explicitly requested maintenance command.
go_env = dict(os.environ)
go_env["GOFLAGS"] = "-p=1"
run(["go", "get", "-u", "-t", "./..."], env=go_env)
run(["go", "mod", "tidy"], env=go_env)
run(["go", "mod", "verify"], env=go_env)
modules = run(["go", "list", "-m", "-f", "{{.Path}} {{.Version}}", "all"],
              env=go_env, capture_output=True, text=True).stdout.splitlines()
audit = subprocess.run(["npm", "--prefix", "web", "audit", "--json"], cwd=ROOT,
                       capture_output=True, text=True, timeout=120)
if audit.returncode not in (0, 1) or len(audit.stdout.encode()) > 1024 * 1024:
    raise SystemExit("Could not obtain bounded npm audit evidence.")
report = {
    "before": before,
    "after": json.loads((ROOT / "web/package.json").read_text(encoding="utf-8")),
    "goModules": modules,
    "npmAudit": json.loads(audit.stdout),
}
for name in ["web/package.json", "web/package-lock.json", "go.mod", "go.sum"]:
    if (ROOT / name).stat().st_size > 4 * 1024 * 1024:
        raise SystemExit("Dependency manifest exceeds its output bound: " + name)
(ROOT / ".validation/dependency-refresh.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print("Dependency manifests and audit evidence ready for review; no application was executed.")
