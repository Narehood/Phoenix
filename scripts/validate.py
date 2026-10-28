"""One command, one owned compiler cache, bounded scratch and retained logs.

When present, reuse the sibling Canary compiler cache AND lock, never its
source/configuration/data. Elsewhere own a single .validation/go-build cache.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.validation'
MIB = 1024 ** 2
SIBLING = ROOT.parent / 'Uptime-Canary'
SHARED = (SIBLING / 'scripts/bounded_validation.py').is_file()
CACHE = SIBLING / '.canary/cache/go-build' if SHARED else STATE / 'go-build'
LOCK = SIBLING / '.canary/bounded-validation.lock' if SHARED else STATE / 'run.lock'


def files(path):
    for base, dirs, names in os.walk(path, followlinks=False):
        dirs[:] = [d for d in dirs if d != '.git' and not (Path(base) / d).is_symlink()
                   and not getattr(os.lstat(Path(base) / d), 'st_file_attributes', 0) & 0x400]
        for name in names:
            p = Path(base) / name
            try:
                info = p.lstat()
                if stat.S_ISREG(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400:
                    yield p, info
            except FileNotFoundError:
                pass


def size(path):
    return sum(info.st_size for _, info in files(path))


def trim_cache():
    total = size(CACHE)
    for p, info in sorted(files(CACHE), key=lambda v: v[1].st_mtime_ns):
        if total <= 256 * MIB:
            break
        target = p.resolve()
        if target.parent.parent != CACHE.resolve():
            continue
        target.unlink()
        total -= info.st_size


def stop_tree(proc):
    if proc.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    proc.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or not 1 <= args.timeout <= 600:
        parser.error('provide a command and timeout <= 600 seconds')
    if os.name == 'nt' and Path(command[0]).stem.lower() == 'go' and 'test' in command and '-c' not in command:
        parser.error('Windows runtime tests are disabled. Use Linux CI or scripts/check.py compile.')
    STATE.mkdir(exist_ok=True)
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        sys.exit('Another validation owns the shared lock. Do not run parallel builds.')
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    scratch = Path(tempfile.mkdtemp(prefix='run-', dir=STATE)).resolve()
    started = time.monotonic()
    proc = None
    reason = ''
    try:
        env = {k: v for k, v in os.environ.items() if not k.startswith(('CANARY_', 'PHOENIX_'))}
        output = scratch / 'outputs'
        output.mkdir()
        CACHE.mkdir(parents=True, exist_ok=True)
        trim_cache()
        env.update(TMP=str(scratch), TEMP=str(scratch), TMPDIR=str(scratch), GOTMPDIR=str(scratch),
                   PHOENIX_OUTPUT=str(output), GOCACHE=str(CACHE.resolve()), GOTOOLCHAIN='local',
                   GOMAXPROCS='2', CGO_ENABLED=env.get('CGO_ENABLED', '0'), GOFLAGS='-p=1 -mod=readonly', PYTHONUTF8='1')
        portable = SIBLING / '.canary/tools/go/bin/go.exe'
        if not shutil.which('go') and portable.is_file():
            env['PATH'] = str(portable.parent) + os.pathsep + env.get('PATH', '')
        resolved = shutil.which(command[0], path=env['PATH'])
        if resolved:
            command[0] = resolved
        default_cache = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.cache'))) / 'go-build'
        go_tool = shutil.which('go', path=env['PATH'])
        module_cache = Path(subprocess.check_output([go_tool, 'env', 'GOMODCACHE'], env=env, text=True).strip())
        baseline_module = size(module_cache)
        if SHARED and size(default_cache) > 16 * MIB:
            sys.exit('Default external compiler cache exceeds 16 MiB; no files deleted.')
        logfile = scratch / 'output.log'
        peak = 0
        with logfile.open('wb') as out:
            proc = subprocess.Popen(command, cwd=ROOT, env=env, stdout=out, stderr=subprocess.STDOUT,
                                    start_new_session=os.name != 'nt')
            while proc.poll() is None:
                scratch_bytes = size(scratch)
                peak = max(peak, scratch_bytes)
                combined = size(ROOT) + (size(SIBLING) if SHARED else 0)
                if time.monotonic() - started > args.timeout:
                    reason = 'deadline exceeded'
                elif combined > 3 * 1024 * MIB or scratch_bytes > 512 * MIB:
                    reason = 'combined repository/scratch storage budget exceeded'
                elif logfile.stat().st_size > 2 * MIB:
                    reason = 'log output budget exceeded'
                elif SHARED and size(default_cache) > 16 * MIB:
                    reason = 'unexpected external compiler-cache growth'
                if reason:
                    stop_tree(proc)
                    break
                time.sleep(1)
        with logfile.open('rb') as f:
            f.seek(max(0, logfile.stat().st_size - 65536))
            tail = f.read().decode(errors='replace')
        print(tail, end='')
        (STATE / 'latest.log').write_text(tail, encoding='utf-8')
        module_growth = size(module_cache) - baseline_module
        if module_growth > 256 * MIB:
            reason = 'shared module-cache growth exceeded 256 MiB; no module files deleted'
        trim_cache()
        result = dict(command=command, exit=proc.returncode, seconds=round(time.monotonic()-started, 2),
                      reason=reason, cache=str(CACHE), cacheBytes=size(CACHE), scratchPeakBytes=peak,
                      moduleGrowthBytes=module_growth, externalCacheBytes=size(default_cache))
        results = STATE / 'results.jsonl'
        prior = results.read_text().splitlines()[-11:] if results.exists() else []
        results.write_text('\n'.join(prior + [json.dumps(result)]) + '\n')
        print(json.dumps(result))
        return 1 if reason else proc.returncode
    finally:
        if proc is not None and proc.poll() is None:
            stop_tree(proc)
        if scratch.parent == STATE.resolve() and scratch.name.startswith('run-'):
            for p, info in files(scratch):
                if not p.resolve().is_relative_to(scratch):
                    raise RuntimeError('Scratch cleanup refused an unexpected path')
            shutil.rmtree(scratch)
        trim_cache()
        LOCK.unlink(missing_ok=True)


if __name__ == '__main__':
    sys.exit(main())
