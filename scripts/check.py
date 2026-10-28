"""Bounded validation steps. Invoke through scripts/validate.py."""
from pathlib import Path
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def run(command, **kwargs):
    print('+', ' '.join(map(str, command)), flush=True)
    subprocess.run(command, check=True, cwd=ROOT, **kwargs)


mode = sys.argv[1] if len(sys.argv) > 1 else 'tests'
if 'PHOENIX_OUTPUT' not in os.environ:
    sys.exit('Run through scripts/validate.py')
if mode == 'format':
    sources = [str(p.relative_to(ROOT)) for parent in ('cmd', 'internal') for p in (ROOT / parent).rglob('*.go')]
    run(['gofmt', '-w', *sources])
elif mode in ('compile', 'vet'):
    env = dict(os.environ, GOOS='linux', GOARCH='amd64', CGO_ENABLED='0' if os.name == 'nt' else os.environ.get('CGO_ENABLED', '1'))
    if mode == 'vet':
        run(['go', 'vet', './...'], env=env)
    else:
        packages = subprocess.check_output(['go', 'list', './...'], env=env, text=True, cwd=ROOT).splitlines()
        for i, package in enumerate(packages):
            run(['go', 'test', '-c', '-o', str(Path(os.environ['PHOENIX_OUTPUT']) / f'{i}.test'), package], env=env)
        print('Linux amd64 compilation only. No test binary executed.')
elif mode == 'tests':
    if os.name == 'nt':
        sys.exit('Use Linux/container CI; Windows test executables are disabled.')
    run(['go', 'test', '-count=1', '-timeout=120s', './...'])
elif mode == 'binaries':
    if os.name == 'nt':
        sys.exit('Build deployment binaries in the Linux container.')
    (ROOT / 'bin').mkdir(exist_ok=True)
    for name in ('phoenix', 'phoenix-agent', 'phoenix-helper'):
        run(['go', 'build', '-trimpath', '-o', str(ROOT / 'bin' / name), './cmd/' + name])
elif mode == 'web':
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'
    run([npm, '--prefix', 'web', 'run', 'build'])
elif mode == 'format-web':
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'
    run([npm, '--prefix', 'web', 'exec', '--', 'prettier', '--write', 'web/src/App.tsx', 'web/src/api.ts', 'web/src/main.tsx', 'web/src/types.ts', 'web/src/styles.css'])
else:
    sys.exit('Unknown check')
