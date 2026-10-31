import io
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

from macos_updater_archive import create_archive, verify_archive


class UpdaterArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / 'ShowPilot Desktop.app'
        (self.app / 'Contents/MacOS').mkdir(parents=True)
        (self.app / 'Contents/Info.plist').write_text('fixture plist')
        (self.app / 'Contents/CodeResources').write_bytes(b'fixture notarization ticket')
        self.binary = self.app / 'Contents/MacOS/showpilot-desktop'
        self.binary.write_bytes(b'fixture executable')
        self.binary.chmod(0o755)
        (self.app / 'Contents/MacOS/current').symlink_to('showpilot-desktop')
        self.archive = self.root / 'update.tar.gz'

    def test_retains_bundle_ticket_executable_mode_and_symlink(self):
        create_archive(self.app, self.archive)
        with tarfile.open(self.archive) as archive:
            prefix = self.app.name + '/Contents/'
            self.assertEqual(archive.extractfile(prefix + 'CodeResources').read(), b'fixture notarization ticket')
            self.assertEqual(archive.getmember(prefix + 'MacOS/showpilot-desktop').mode & 0o777, 0o755)
            link = archive.getmember(prefix + 'MacOS/current')
            self.assertTrue(link.issym())
            self.assertEqual(link.linkname, 'showpilot-desktop')

    def test_extended_attributes_do_not_create_appledouble_entries(self):
        if shutil.which('xattr'):
            for path in (self.app, self.binary):
                subprocess.run(['xattr', '-w', 'com.showpilot.archive-test', 'metadata', str(path)], check=True)
        elif hasattr(os, 'setxattr'):
            try:
                for path in (self.app, self.binary):
                    os.setxattr(path, 'user.showpilot.archive-test', b'metadata')
            except OSError as error:
                self.skipTest(str(error))
        else:
            self.skipTest('Requires extended attribute support')
        create_archive(self.app, self.archive)
        with tarfile.open(self.archive) as archive:
            self.assertFalse(any('._' in member.name for member in archive))

    def test_rejects_the_published_root_metadata_failure(self):
        with tarfile.open(self.archive, 'w:gz') as archive:
            metadata = tarfile.TarInfo('._' + self.app.name)
            metadata.size = 8
            archive.addfile(metadata, io.BytesIO(b'metadata'))
            archive.add(self.app, arcname=self.app.name)
        with self.assertRaisesRegex(ValueError, 'Unsupported updater archive entry'):
            verify_archive(self.archive, self.app.name)

    def test_rejects_existing_nested_metadata_files(self):
        (self.app / 'Contents/._Info.plist').write_bytes(b'metadata')
        with self.assertRaisesRegex(ValueError, 'Unsupported updater archive entry'):
            create_archive(self.app, self.archive)

    def test_rejects_a_second_top_level_entry(self):
        with tarfile.open(self.archive, 'w:gz') as archive:
            archive.add(self.app, arcname=self.app.name)
            archive.addfile(tarfile.TarInfo('extra-file'))
        with self.assertRaisesRegex(ValueError, 'Unsupported updater archive entry'):
            verify_archive(self.archive, self.app.name)

    def test_rejects_missing_bundle(self):
        with self.assertRaisesRegex(ValueError, 'complete app bundle'):
            create_archive(self.root / 'missing.app', self.archive)


if __name__ == '__main__':
    unittest.main()
