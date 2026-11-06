"""Release transfer guards use tiny, newly generated in-memory fixtures."""
import io
import json
import tarfile
import unittest
from unittest.mock import patch
import zipfile

import prepare_release as release


class ReleaseTransferTests(unittest.TestCase):
    def zipped(self, files):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            for name, content in files.items():
                archive.writestr(name, content)
        body = data.getvalue()
        return body, {"id": 1, "expired": False, "size_in_bytes": len(body), "digest": "sha256:" + release.sha(body)}

    def test_outer_and_inner_checksums_and_members_are_required(self):
        name, payload = "build.tar.gz", b"temporary fixture"
        files = {name: payload, "SHA256SUMS": (release.sha(payload) + "  " + name + "\n").encode()}
        body, metadata = self.zipped(files)
        with patch.object(release, "command", return_value=body):
            self.assertEqual(release.unpack_artifact(metadata, set(files)), files)
            with self.assertRaises(ValueError):
                release.unpack_artifact({**metadata, "digest": "sha256:" + "0" * 64}, set(files))
            with self.assertRaises(ValueError):
                release.unpack_artifact(metadata, {name, "../SHA256SUMS"})
        body, metadata = self.zipped({**files, "SHA256SUMS": b"wrong checksum"})
        with patch.object(release, "command", return_value=body), self.assertRaises(ValueError):
            release.unpack_artifact(metadata, set(files))

    def test_kit_requires_complete_checksums_and_rejects_links(self):
        info = json.dumps({"sourceSha": "a" * 40}).encode()
        def kit(extra=None, checksum=True):
            output = io.BytesIO()
            files = {"build-info.json": info}
            files["SHA256SUMS"] = ((release.sha(info) if checksum else "0" * 64) + "  build-info.json\n").encode()
            with tarfile.open(fileobj=output, mode="w:gz") as archive:
                for name, content in files.items():
                    member = tarfile.TarInfo("phoenix-test-kit/" + name)
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
                if extra:
                    archive.addfile(extra)
            return output.getvalue()
        self.assertEqual(release.kit_info(kit()), info)
        with self.assertRaises(ValueError):
            release.kit_info(kit(checksum=False))
        link = tarfile.TarInfo("phoenix-test-kit/linked")
        link.type, link.linkname = tarfile.SYMTYPE, "../../outside"
        with self.assertRaises(ValueError):
            release.kit_info(kit(extra=link))


if __name__ == "__main__":
    unittest.main()
