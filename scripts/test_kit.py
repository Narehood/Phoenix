"""Package the allowlisted Docker test-kit export through validate.py."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def checksum(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def main():
    if 'PHOENIX_OUTPUT' not in os.environ or len(sys.argv) != 2 or not re.fullmatch(r'[a-f0-9]{40}', sys.argv[1]):
        sys.exit('Use validate.py with the exact tested checkout SHA.')
    kit = ROOT / '.validation/test-kit'
    artifact = ROOT / '.validation/test-kit-artifact'
    # The Docker target selects only binaries, built web assets, examples and docs.
    files = sorted(kit.rglob('*'))
    if any(p.is_symlink() for p in files):
        sys.exit('Refusing a test kit containing links.')
    files = [p for p in files if p.is_file() and p.name not in ('build-info.json', 'SHA256SUMS')]
    required = ['bin/phoenix', 'bin/phoenix-agent', 'bin/phoenix-helper',
                'web/index.html', 'docs/testing.md', 'deploy/agent.example.json']
    if not all((kit / p).is_file() for p in required) or len(files) > 128 or sum(p.stat().st_size for p in files) > 96 * 1024**2:
        sys.exit('Incomplete or oversized test kit.')
    info = kit / 'build-info.json'
    info.write_text(json.dumps({'sourceSha': sys.argv[1], 'platform': 'linux/amd64',
        'status': 'development test build', 'runtime': 'Debian 13/systemd acceptance pending',
        'checks': ['Debian CGO fixtures', 'vet', 'race', 'nonroot binary smoke'],
        'limits': ['no real systemd/helper acceptance', 'no live GitHub/Canary acceptance',
                   'not signed or production ready']}, indent=2) + '\n', encoding='utf-8')
    files.append(info)
    sums = kit / 'SHA256SUMS'
    sums.write_text(''.join(f'{checksum(p)}  {p.relative_to(kit).as_posix()}\n'
                            for p in files), encoding='utf-8')
    files.append(sums)
    artifact.mkdir(exist_ok=True)
    archive = artifact / 'phoenix-linux-amd64-test-kit.tar.gz'
    with tarfile.open(archive, 'w:gz') as tar:
        for p in files:
            tar.add(p, arcname='phoenix-test-kit/' + p.relative_to(kit).as_posix(), recursive=False)
    digest = checksum(archive)
    (artifact / 'SHA256SUMS').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
    print(f'Packaged {len(files)} files for {sys.argv[1]} ({archive.stat().st_size} bytes).')


if __name__ == '__main__':
    main()
