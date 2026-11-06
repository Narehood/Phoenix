"""Consume a temporary test kit twice and verify the delivered checksums."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import test_kit


@unittest.skipUnless(sys.platform == 'linux', 'Runtime fixtures require Linux CI')
class TestKitTests(unittest.TestCase):
    def test_fresh_and_repeated_packaging_preserves_content_and_checksums(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            kit = root / '.validation/test-kit'
            names = ['bin/phoenix', 'bin/phoenix-agent', 'bin/phoenix-helper',
                     'web/index.html', 'docs/testing.md', 'deploy/agent.example.json']
            for name in names:
                path = kit / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(('temporary fixture ' + name).encode())
                if name.startswith('bin/'):
                    path.chmod(0o755)
            for sha in ('1' * 40, '2' * 40):
                with patch.object(test_kit, 'ROOT', root), patch.object(sys, 'argv', ['test_kit.py', sha]):
                    test_kit.main()
                artifact = root / '.validation/test-kit-artifact'
                archive = artifact / 'phoenix-linux-amd64-test-kit.tar.gz'
                with archive.open('rb') as f:
                    digest = hashlib.file_digest(f, 'sha256').hexdigest()
                self.assertEqual((artifact / 'SHA256SUMS').read_text(), f'{digest}  {archive.name}\n')
                with tarfile.open(archive) as tar:
                    members = tar.getmembers()
                    self.assertEqual(len({m.name for m in members}), len(names) + 2)
                    self.assertTrue(all(m.isfile() for m in members))
                    checksums = tar.extractfile('phoenix-test-kit/SHA256SUMS').read().decode()
                    for row in checksums.splitlines():
                        expected, name = row.split('  ', 1)
                        body = tar.extractfile('phoenix-test-kit/' + name).read()
                        self.assertEqual(hashlib.sha256(body).hexdigest(), expected)
                    self.assertEqual(len(checksums.splitlines()), len(names) + 1)
                    info = json.load(tar.extractfile('phoenix-test-kit/build-info.json'))
                    self.assertEqual(info['sourceSha'], sha)
                    self.assertEqual(tar.getmember('phoenix-test-kit/bin/phoenix-agent').mode & 0o777, 0o755)


if __name__ == '__main__':
    unittest.main()
