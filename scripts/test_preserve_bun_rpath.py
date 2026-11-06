import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("preserve_bun", Path(__file__).with_name("preserve-bun-rpath.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PreserveBunRpathTests(unittest.TestCase):
    def test_only_expected_appdir_engine_maps_to_its_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for app in ("desktop", "bridge-desktop"):
                tauri = root / "apps" / app / "src-tauri"
                target = tauri / "target/release/bundle/appimage/Fixture.AppDir/usr/bin/showpilot-bridge"
                self.assertEqual(module.source_for_sidecar(target, root), tauri.resolve() / "binaries/showpilot-bridge-x86_64-unknown-linux-gnu")
                self.assertIsNone(module.source_for_sidecar(target.with_name("showpilot-desktop"), root))
                self.assertIsNone(module.source_for_sidecar(target.parent.parent / "lib/showpilot-bridge", root))
            self.assertIsNone(module.source_for_sidecar(root / "elsewhere/Fixture.AppDir/usr/bin/showpilot-bridge", root))

    def test_preserves_identical_sidecar_and_rejects_a_changed_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            target = Path(directory) / "target"
            source.write_bytes(b"\x7fELFfixture-bun-runtime")
            target.write_bytes(source.read_bytes())
            with patch.object(module, "source_for_sidecar", return_value=source), patch.object(module.subprocess, "run") as run:
                self.assertEqual(module.main(["--set-rpath", "$ORIGIN/../lib", str(target)]), 0)
                run.assert_not_called()
                target.write_bytes(b"changed")
                with self.assertRaisesRegex(RuntimeError, "differs"):
                    module.main(["--set-rpath", "$ORIGIN/../lib", str(target)])

    def test_all_other_operations_preserve_real_tool_errors_and_arguments(self):
        for args in (["--print-rpath", "engine"], ["--set-rpath", "$ORIGIN", "other-library"]):
            with patch.object(module, "source_for_sidecar", return_value=None), patch.object(module.subprocess, "run") as run:
                run.return_value.returncode = 7
                self.assertEqual(module.main(args), 7)
                run.assert_called_once_with(["/usr/bin/patchelf", *args], check=False)


if __name__ == "__main__":
    unittest.main()
