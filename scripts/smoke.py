"""Built-binary Linux smoke test. Only fresh temporary state and loopback TLS.

Invoke through validate.py in the Docker smoke stage, as an unprivileged user.
Never installs services, invokes the helper, restarts a service, or reboots.
"""
import base64
import hashlib
import hmac
import http.cookiejar
import json
import math
import os
from pathlib import Path
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 64 * 1024


def require(condition):
    if not condition:
        raise RuntimeError('smoke assertion failed')


def code(secret):
    key = base64.b32decode(secret + '=' * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack('>Q', int(time.time()) // 30), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return f'{(struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7fffffff) % 1000000:06d}'


class Smoke:
    def __init__(self, directory):
        self.root = directory
        self.processes = []
        self.logs = []
        self.csrf = ''
        self.stage = 'initialization'

    def mark(self, stage):
        self.stage = stage
        print('smoke:', stage, flush=True)

    def check(self):
        require(all(p.poll() is None for p in self.processes))
        require(all(p.stat().st_size <= LIMIT for p in self.logs))

    def command(self, name, *args):
        result = subprocess.run([str(ROOT / 'bin' / name), *args],
                                capture_output=True, timeout=10, check=False)
        require(result.returncode == 0 and len(result.stdout) + len(result.stderr) <= LIMIT)
        return result.stdout

    def start(self, name, *args):
        path = self.root / f'process-{len(self.logs)}.log'
        with path.open('wb') as log:
            proc = subprocess.Popen([str(ROOT / 'bin' / name), *args], stdout=log,
                                    stderr=subprocess.STDOUT, start_new_session=True)
        self.processes.append(proc)
        self.logs.append(path)

    def stop(self):
        stopped = self.processes
        self.processes = []
        clean = True
        for proc in reversed(stopped):
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=5)
            clean = clean and proc.returncode == 0
        require(clean)

    def wait(self, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.check()
            result = predicate()
            if result:
                return result
            time.sleep(0.25)
        raise RuntimeError('smoke deadline exceeded')

    def browser(self, identity):
        context = ssl.create_default_context(cafile=str(identity / 'ca.pem'))
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        self.cookies = http.cookiejar.CookieJar()
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                    urllib.request.HTTPSHandler(context=context),
                    urllib.request.HTTPCookieProcessor(self.cookies))

    def request(self, method, path, body=None, status=200, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.origin + path, data=data, method=method,
            headers={'Origin': self.origin, 'Content-Type': 'application/json',
                     'X-CSRF-Token': self.csrf})
        try:
            response = self.http.open(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            require(response.code == status)
            payload = response.read(LIMIT + 1)
            require(len(payload) <= LIMIT)
            return payload if raw else json.loads(payload)

    def ready(self):
        try:
            return self.request('GET', '/api/auth/status')['setupRequired'] is not None
        except urllib.error.URLError:
            return False

    def run(self):
        self.mark('fresh initialization and TLS listeners')
        # Reserve two distinct loopback ports together before handing them to Go.
        with socket.socket() as web, socket.socket() as agent:
            web.bind(('127.0.0.1', 0))
            agent.bind(('127.0.0.1', 0))
            web_port, agent_port = web.getsockname()[1], agent.getsockname()[1]
        self.origin = f'https://127.0.0.1:{web_port}'
        identity = self.root / 'identity'
        config = {'dataDir': str(self.root / 'data'), 'identityDir': str(identity),
                  'origin': self.origin, 'webListen': f'127.0.0.1:{web_port}',
                  'agentListen': f'127.0.0.1:{agent_port}', 'webDir': str(ROOT / 'web-dist')}
        server_config = self.root / 'server.json'
        server_config.write_text(json.dumps(config))
        self.command('phoenix', 'init', '-config', str(server_config))
        self.browser(identity)
        self.start('phoenix', 'serve', '-config', str(server_config))
        self.wait(self.ready)
        require(b'<html' in self.request('GET', '/', raw=True).lower())
        self.request('GET', '/api/hosts', status=401)

        self.mark('bootstrap MFA and secure browser session')
        token = (identity / 'setup.token').read_text()
        password = os.urandom(24).hex()
        begin = self.request('POST', '/api/auth/setup/begin',
                             {'token': token, 'name': 'Smoke admin', 'password': password})
        auth = self.request('POST', '/api/auth/setup/finish',
                            {'token': token, 'code': code(begin['secret'])}, status=201)
        self.csrf = auth['csrfToken']
        require(any(c.name == '__Host-phoenix' and c.secure and
                    c.has_nonstandard_attr('HttpOnly') and
                    c.get_nonstandard_attr('SameSite') == 'Strict' for c in self.cookies))
        require(self.request('GET', '/api/projects')['projects'] == [])
        self.request('POST', '/api/projects', {'id': 'smoke-project', 'name': 'Smoke project',
                     'description': 'Temporary binary smoke fixture', 'modules': ['dependencies']}, status=201)
        require(self.request('GET', '/api/projects/smoke-project/github')['state'] == 'not_configured')

        self.mark('agent CLI enrollment, identity approval and outbound mTLS')
        invitation = self.request('POST', '/api/invitations',
                                   {'name': 'Smoke Debian', 'groups': ['smoke']}, status=201)
        invitation_file = self.root / 'invitation.token'
        invitation_file.write_text(invitation['invitation'])
        agent_config = self.root / 'agent.json'
        agent_config.write_text(json.dumps({'serverOrigin': self.origin,
            'agentOrigin': f'https://127.0.0.1:{agent_port}', 'caFile': str(identity / 'ca.pem'),
            'stateDir': str(self.root / 'agent'), 'policy': {'allowReboot': False}}))
        self.command('phoenix-agent', 'enroll', '-config', str(agent_config),
                     '-invitation-file', str(invitation_file))
        public = json.loads(self.command('phoenix-agent', 'identity', '-config', str(agent_config)))
        host = public['hostId']
        require(host == invitation['hostId'])
        self.request('POST', f'/api/hosts/{host}/jobs',
                     {'action': 'diagnostic', 'args': {'diagnostic': 'system.summary'}}, status=409)
        self.request('POST', f'/api/hosts/{host}/approve',
                     {'confirm': host, 'certificateFingerprint': public['certificateFingerprint']})
        invitation_file.unlink()
        self.start('phoenix-agent', 'run', '-config', str(agent_config))

        self.mark('real unprivileged procfs telemetry and safe diagnostic receipt')
        def reading():
            hosts = self.request('GET', '/api/hosts')['hosts']
            require(len(hosts) == 1 and hosts[0]['id'] == host)
            return hosts[0]['latest']
        first = self.wait(reading)
        require(first['memoryTotal'] > 0 and first['diskTotal'] > 0 and first['bootId'])
        require(0 < len(first['processes']) <= 100 and len(first['services']) <= 100)
        job = self.request('POST', f'/api/hosts/{host}/jobs',
                           {'action': 'diagnostic', 'args': {'diagnostic': 'system.summary'}}, status=201)
        def receipt():
            result = self.request('GET', '/api/jobs/' + job['id'])
            return result if result['state'] == 'succeeded' else None
        result = self.wait(receipt)
        require(result['result']['exitCode'] == 0 and 'Linux' in result['result']['stdout'])
        def second_reading():
            value = reading()
            return value if value and value['measuredAt'] > first['measuredAt'] else None
        second = self.wait(second_reading, timeout=40)
        require(second['cpuPercent'] is not None and 0 <= second['cpuPercent'] <= 100)
        require(all(second[key] is not None and math.isfinite(second[key]) and second[key] >= 0
                    for key in ('networkRxBps', 'networkTxBps')))
        self.check()
        self.stop()

        self.mark('stopped backup, isolated restore and offline session recovery')
        restored = self.root / 'restored'
        shutil.copytree(self.root / 'data', restored / 'data')
        shutil.copytree(identity, restored / 'identity')
        config.update(dataDir=str(restored / 'data'), identityDir=str(restored / 'identity'))
        server_config.write_text(json.dumps(config))
        self.command('phoenix', 'recover-admin', '-config', str(server_config), '-account', 'Smoke admin')
        recovery = json.loads((restored / 'identity' / 'admin-recovery.secret').read_text())
        self.start('phoenix', 'serve', '-config', str(server_config))
        self.wait(self.ready)
        # Keep the old cookie jar: restored sessions must have been revoked.
        self.request('GET', '/api/session', status=401)
        auth = self.request('POST', '/api/auth/login', {'name': recovery['name'],
                             'password': recovery['password'], 'code': code(recovery['totpSecret'])})
        self.csrf = auth['csrfToken']
        require(self.request('GET', '/api/projects/smoke-project')['id'] == 'smoke-project')
        require(self.request('GET', '/api/jobs/' + job['id'])['state'] == 'succeeded')
        require(self.request('GET', '/api/hosts')['hosts'][0]['id'] == host)
        self.check()
        self.stop()
        self.mark('passed (container only; no installed systemd/helper or live integrations)')


def main():
    if sys.platform != 'linux' or os.geteuid() == 0 or 'PHOENIX_OUTPUT' not in os.environ:
        sys.exit('Smoke tests require the guarded unprivileged Linux Docker stage.')
    os.umask(0o077)
    with tempfile.TemporaryDirectory(dir=os.environ['PHOENIX_OUTPUT'], prefix='smoke-') as temporary:
        smoke = Smoke(Path(temporary))
        try:
            smoke.run()
        except Exception:
            # Never dump credential-bearing request/response bodies or subprocess output.
            print('smoke failed at:', smoke.stage, file=sys.stderr)
            raise SystemExit(1) from None
        finally:
            try:
                smoke.stop()
            except Exception:
                sys.exit('smoke: process cleanup failed')


if __name__ == '__main__':
    main()
