"""Promote a successful main build; publishing remains outside validation."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPO = "Narehood/Phoenix"
DEST = ROOT / ".validation/release-assets"


def command(args, limit=4 * 1024 * 1024):
    value = subprocess.check_output(args, cwd=ROOT, timeout=90)
    if len(value) > limit:
        raise ValueError("Command output exceeded its bound")
    return value


def api(path):
    return json.loads(command(["gh", "api", f"repos/{REPO}/{path}"]))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def artifact_zip(metadata):
    if metadata["expired"] or not 0 < metadata["size_in_bytes"] <= 64 * 1024 * 1024:
        raise ValueError("Unavailable or oversized build artifact")
    data = command(["gh", "api", f"repos/{REPO}/actions/artifacts/{metadata['id']}/zip"], 64 * 1024 * 1024)
    if len(data) != metadata["size_in_bytes"] or "sha256:" + sha(data) != metadata["digest"]:
        raise ValueError("Artifact ZIP checksum mismatch")
    archive = zipfile.ZipFile(io.BytesIO(data))
    if sum(member.file_size for member in archive.infolist()) > 64 * 1024 * 1024:
        archive.close()
        raise ValueError("Expanded artifact exceeds its bound")
    return archive


def unpack_artifact(metadata, allowed):
    with artifact_zip(metadata) as archive:
        if set(archive.namelist()) != allowed or len(archive.namelist()) != len(allowed):
            raise ValueError("Unexpected artifact members")
        files = {name: archive.read(name) for name in allowed}
    archive_name = next(name for name in allowed if name.endswith(".tar.gz"))
    if files["SHA256SUMS"].decode().strip() != sha(files[archive_name]) + "  " + archive_name:
        raise ValueError("Inner archive checksum mismatch")
    return files


def kit_info(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        members = archive.getmembers()
        prefix = "phoenix-test-kit/"
        if len(members) > 128 or sum(m.size for m in members) > 96 * 1024 * 1024:
            raise ValueError("Test kit exceeds its bound")
        if any(not m.isfile() or not m.name.startswith(prefix) or ".." in Path(m.name).parts for m in members):
            raise ValueError("Unexpected test-kit member")
        files = {m.name[len(prefix):]: m for m in members}
        if len(files) != len(members):
            raise ValueError("Duplicate test-kit member")
        sums = archive.extractfile(files["SHA256SUMS"]).read().decode().splitlines()
        checks = dict(line.split("  ", 1)[::-1] for line in sums)
        if len(checks) != len(sums) or set(checks) != set(files) - {"SHA256SUMS"}:
            raise ValueError("Incomplete kit checksums")
        for name, expected in checks.items():
            with archive.extractfile(files[name]) as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                    raise ValueError("Test-kit file checksum mismatch")
        return archive.extractfile(files["build-info.json"]).read()


def prepare(run_id, tag):
    if sys.platform != "linux" or not os.environ.get("PHOENIX_OUTPUT"):
        raise ValueError("Prepare through validate.py in Linux CI")
    run = api(f"actions/runs/{run_id}")
    if (run["status"], run["conclusion"], run["event"], run["head_branch"]) != ("completed", "success", "push", "main"):
        raise ValueError("A successful main build is required")
    if run["workflow_id"] != api("actions/workflows/ci.yml")["id"]:
        raise ValueError("Unexpected source workflow")
    jobs = api(f"actions/runs/{run_id}/jobs")["jobs"]
    if not any(j["name"] == "debian-fixtures" and j["conclusion"] == "success" for j in jobs):
        raise ValueError("Source run did not pass Linux validation")
    source = run["head_sha"]
    ref = api(f"git/ref/tags/{tag}")["object"]
    if ref["type"] != "commit" or ref["sha"] != source:
        raise ValueError("Release tag differs from the tested source")
    artifacts = api(f"actions/runs/{run_id}/artifacts")["artifacts"]
    def artifact(name):
        matches = [a for a in artifacts if a["name"] == name]
        if len(matches) != 1:
            raise ValueError("Missing or duplicate build artifact")
        return matches[0]
    kit_name = "phoenix-linux-amd64-test-kit.tar.gz"
    image_name = "phoenix-linux-amd64-image.tar.gz"
    kit = unpack_artifact(artifact("phoenix-linux-amd64-test-kit"), {kit_name, "SHA256SUMS"})
    image = unpack_artifact(artifact("phoenix-linux-amd64-server-image"), {image_name, "SHA256SUMS", "image.json"})
    build_info = kit_info(kit[kit_name])
    build = json.loads(build_info)
    info = json.loads(image["image.json"])
    with artifact_zip(artifact("phoenix-browser-evidence")) as evidence:
        if evidence.getinfo("results.json").file_size > 64 * 1024:
            raise ValueError("Oversized browser result")
        browser = json.loads(evidence.read("results.json"))
        if browser["status"] != "passed" or browser["cases"] < 1 or browser["refreshDelays"] != "Production timers":
            raise ValueError("Missing production-timer browser proof")
    if build["sourceSha"] != source or info["revision"] != source or info["sourceTree"] != api(f"git/commits/{source}")["tree"]["sha"]:
        raise ValueError("Artifact source identities disagree")
    if build["platform"] != "linux/amd64" or info["platform"] != "linux/amd64" or info["sha256"] != sha(image[image_name]):
        raise ValueError("Unexpected image platform or checksum")
    image_ref = "ghcr.io/narehood/phoenix:" + tag[1:]
    compose = command(["git", "show", f"{source}:deploy/compose.yaml"]).decode()
    build_block = "    build:\n      context: ..\n      target: server\n"
    if compose.count(build_block) != 1 or compose.count("    image: phoenix:development") != 1:
        raise ValueError("Unexpected source Compose template")
    compose = compose.replace(build_block, "").replace("    image: phoenix:development", "    image: " + image_ref)
    notes = f"""# Phoenix {tag}: Debian testing

Testing prerelease from `{source}`; [validated Linux build]({run['html_url']}).
Includes the server image, dashboard, Linux amd64 agent/helper and configuration examples.
Backend fixtures, vet/race, unprivileged binary smoke and all {browser['cases']} browser regressions passed.

## Container

```sh
docker pull {image_ref}
```

The `testing` image tag points to this testing release. GHCR may require login
with a GitHub token having `read:packages` when the package is private.
The downloadable image archive also works without registry access:

```sh
sha256sum -c SHA256SUMS
docker load --input {image_name}
docker tag phoenix:git-{source[:12]} {image_ref}
```

## Fresh test installation

Download all release assets into a new directory on a disposable Debian 13 amd64
Docker host. Verify `SHA256SUMS`, unpack `{kit_name}`, then verify the kit's own
checksums. Copy `phoenix-test-kit/deploy/server.example.json` to `server.json` and
set its origin to the exact HTTPS DNS name you will use. Keep the data/identity
paths from the example. Then initialize the new installation:

```sh
docker compose -f compose.release.yaml run --rm phoenix init -config /etc/phoenix/server.json
```

Follow the [CA trust and first-administrator steps](https://github.com/{REPO}/blob/{source}/docs/operations.md#build-and-run-the-server)
before submitting credentials; then run `docker compose -f compose.release.yaml up -d`.
The setup token is a private file in the identity volume; initialization prints
its path. The release contains no accounts, tokens, private keys or database.
The agent/helper binaries and the [full acceptance matrix](https://github.com/{REPO}/blob/{source}/docs/testing.md)
are in the Linux kit. The Compose server container is not a systemd agent host.

Installed Debian/systemd/helper operation, live GitHub/Canary interoperability,
screen-reader and real-device touch acceptance remain pending. Reboot remains
disabled in the example policies. Windows, SSH and production acceptance are
outside this testing release. Checksums detect transfer changes; artifacts are unsigned.
"""
    DEST.mkdir(parents=True, exist_ok=False)
    files = {kit_name: kit[kit_name], image_name: image[image_name], "build-info.json": build_info,
             "image.json": image["image.json"], "compose.release.yaml": compose.encode(), "TESTING.md": notes.encode()}
    manifest = {"tag": tag, "sourceSha": source, "sourceRun": run_id, "image": image_ref,
                "imageId": info["imageId"], "platform": "linux/amd64"}
    files["release-manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    files["SHA256SUMS"] = "".join(f"{sha(data)}  {name}\n" for name, data in sorted(files.items())).encode()
    for name, data in files.items():
        (DEST / name).write_bytes(data)
    (ROOT / ".validation/release-notes.md").write_text(notes, encoding="utf-8")
    subprocess.run(["docker", "load", "--input", str(DEST / image_name)], check=True, timeout=90)
    loaded = command(["docker", "image", "inspect", "--format", "{{.Id}} {{.Os}}/{{.Architecture}}", "phoenix:git-" + source[:12]]).decode().strip()
    if loaded != info["imageId"] + " linux/amd64":
        raise ValueError("Loaded image differs from the tested image")
    subprocess.run(["docker", "tag", "phoenix:git-" + source[:12], image_ref], check=True, timeout=30)
    print(json.dumps(manifest))


def verify(tag):
    matches = [r for r in api("releases?per_page=100") if r["tag_name"] == tag]
    if len(matches) != 1:
        raise ValueError("Missing or duplicate draft release")
    release = matches[0]
    expected = {p.name: p for p in DEST.iterdir() if p.is_file()}
    assets = api(f"releases/{release['id']}/assets")
    if not release["draft"] or not release["prerelease"] or {a["name"] for a in assets} != set(expected):
        raise ValueError("Unexpected draft release or asset set")
    for asset in assets:
        path = expected[asset["name"]]
        if asset["state"] != "uploaded" or asset["size"] != path.stat().st_size or asset["digest"] != "sha256:" + sha(path.read_bytes()):
            raise ValueError("Uploaded release asset checksum mismatch")
    print(f"Verified {len(assets)} uploaded assets before publication")


if __name__ == "__main__":
    if len(sys.argv) != 4 or not re.fullmatch(r"[1-9][0-9]*", sys.argv[2]) or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+-rc\.[1-9][0-9]*", sys.argv[3]):
        raise SystemExit("Use prepare|verify RUN_ID vX.Y.Z-rc.N")
    if sys.argv[1] == "prepare":
        prepare(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "verify":
        verify(sys.argv[3])
    else:
        raise SystemExit("Unknown release operation")
