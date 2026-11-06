"""Export the tested development server image without starting Phoenix."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
if sys.platform != "linux" or not os.environ.get("PHOENIX_OUTPUT"):
    raise SystemExit("Run image export through scripts/validate.py in Linux CI.")
revision = sys.argv[1] if len(sys.argv) == 2 else ""
if not re.fullmatch(r"[0-9a-f]{40}", revision):
    raise SystemExit("An exact tested revision is required.")


def output(command):
    value = subprocess.check_output(command, cwd=ROOT, timeout=60)
    if len(value) > 256 * 1024:
        raise SystemExit("Image metadata exceeds its output bound.")
    return value.decode().strip()


if output(["git", "rev-parse", "HEAD"]) != revision:
    raise SystemExit("Tested revision differs from the checkout.")
image_id, image_os, architecture = output([
    "docker", "image", "inspect", "--format", "{{.Id}} {{.Os}} {{.Architecture}}", "phoenix:ci",
]).split()
if (image_os, architecture) != ("linux", "amd64"):
    raise SystemExit("Unexpected server image platform.")
tags = ["phoenix:development", "phoenix:git-" + revision[:12]]
for tag in tags:
    subprocess.run(["docker", "image", "tag", "phoenix:ci", tag], check=True, timeout=30)
dest = ROOT / ".validation/server-image-artifact"
dest.mkdir(exist_ok=False)
archive = dest / "phoenix-linux-amd64-image.tar.gz"
process = subprocess.Popen(["docker", "image", "save", *tags], stdout=subprocess.PIPE)
try:
    size = 0
    with archive.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
        while chunk := process.stdout.read(1024 * 1024):
            size += len(chunk)
            if size > 384 * 1024 * 1024:
                raise RuntimeError("Server image exceeds its export bound.")
            compressed.write(chunk)
    if process.wait(timeout=30) != 0:
        raise RuntimeError("Docker image export failed.")
finally:
    process.stdout.close()
    if process.poll() is None:
        process.kill()
        process.wait(timeout=30)
with archive.open("rb") as source:
    digest = hashlib.file_digest(source, "sha256").hexdigest()
packages = output([
    "docker", "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true", "--pids-limit=64", "--memory=128m",
    "--entrypoint=/usr/bin/dpkg-query", "phoenix:ci", "-W", "-f=${Package} ${Version}\n",
]).splitlines()
metadata = {
    "revision": revision,
    "sourceTree": output(["git", "rev-parse", "HEAD^{tree}"]),
    "imageId": image_id,
    "platform": image_os + "/" + architecture,
    "tags": tags,
    "archive": archive.name,
    "sha256": digest,
    "baseImages": [line.split(" AS ")[0][5:] for line in (ROOT / "Dockerfile").read_text().splitlines()
                   if line.startswith("FROM ") and not line.startswith("FROM scratch") and "@sha256:" in line],
    "packages": packages,
    "scope": "Development image; installed systemd/helper and live integrations are not accepted by this build.",
}
(dest / "image.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
(dest / "SHA256SUMS").write_text(digest + "  " + archive.name + "\n", encoding="utf-8")
print(json.dumps({"image": image_id, "revision": revision, "sha256": digest, "bytes": archive.stat().st_size}))
