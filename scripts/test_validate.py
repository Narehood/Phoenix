"""Linux-only fixtures for the bounded validation runner."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import validate


@unittest.skipUnless(sys.platform == 'linux', 'Runtime fixtures require Linux CI')
class TraversalTests(unittest.TestCase):
    def test_vanished_directory_keeps_link_and_git_exclusions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            live = root / 'live'
            live.mkdir()
            (root / '.git').mkdir()
            (root / 'link').symlink_to(live, target_is_directory=True)
            (root / 'root.txt').write_bytes(b'root')
            (live / 'data.txt').write_bytes(b'data')
            # os.walk saw "vanished" before Go removed it. The subsequent
            # lstat must tolerate its absence while still pruning links/.git.
            directories = ['vanished', 'live', 'link', '.git']
            snapshot = [(str(root), directories, ['root.txt', 'gone.txt']),
                        (str(live), [], ['data.txt'])]
            with patch.object(validate.os, 'walk', return_value=iter(snapshot)):
                entries = list(validate.files(root))
            self.assertEqual(directories, ['live'])
            self.assertEqual({path for path, _ in entries},
                             {root / 'root.txt', live / 'data.txt'})
            self.assertEqual(sum(info.st_size for _, info in entries), 8)


if __name__ == '__main__':
    unittest.main()
