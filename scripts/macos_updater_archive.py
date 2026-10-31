#!/usr/bin/env python3
"""Create a macOS updater tarball without AppleDouble metadata entries."""
import argparse
from pathlib import Path, PurePosixPath
import tarfile


def verify_archive(archive_path, app_name):
    """Tauri removes one path component before unpacking every archive entry."""
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        for member in members:
            parts = PurePosixPath(member.name).parts
            if (not parts or parts[0] != app_name or '..' in parts
                    or any(part.startswith('._') for part in parts)):
                raise ValueError(f'Unsupported updater archive entry: {member.name}')
            if len(parts) == 1 and not member.isdir():
                raise ValueError('The updater archive root must be an app directory')
        names = {member.name for member in members}
        if app_name not in names or f'{app_name}/Contents/Info.plist' not in names:
            raise ValueError('Updater archive is missing its app root or Info.plist')


def create_archive(app, destination):
    app = Path(app).resolve()
    if app.suffix != '.app' or not (app / 'Contents/Info.plist').is_file():
        raise ValueError(f'Expected a complete app bundle: {app}')
    # Python tarfile retains file modes and symlinks but does not synthesize
    # macOS ._ metadata files. The stapled ticket is Contents/CodeResources;
    # finalize-macos-release.sh validates it again after archive extraction.
    with tarfile.open(destination, 'w:gz', dereference=False) as archive:
        archive.add(app, arcname=app.name)
    verify_archive(destination, app.name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('archive', type=Path)
    args = parser.parse_args()
    create_archive(args.app, args.archive)
    print(f'Verified updater archive structure: {args.archive.name}')
