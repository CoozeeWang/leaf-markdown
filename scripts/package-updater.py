"""Build an unsigned Leaf updater archive; signing remains with the release custodian."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tarfile


def build(source, output, version, platform, arch):
    source, output = Path(source), Path(output)
    root = 'Leaf.app' if platform == 'darwin' else 'Leaf'
    if source.is_symlink() or not source.is_dir() or output.exists():
        raise ValueError('regular source directory and fresh output required')
    if output.resolve().is_relative_to(source.resolve()):
        raise ValueError('output must remain outside the payload')
    records = []
    paths = [(source, root)]
    def collect(directory, relative):
        for path in sorted(directory.iterdir()):
            name = relative + '/' + path.name
            if any(part in ('', '.', '..') for part in name.split('/')) or '\\' in name or ':' in name:
                raise ValueError('unsafe payload path')
            paths.append((path, name))
            if path.is_dir() and not path.is_symlink():
                collect(path, name)
    collect(source, root)
    for path, name in paths:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            if platform != 'darwin' or not path.resolve().is_relative_to(source.resolve()):
                raise ValueError('unsafe symlink')
            item = dict(path=name, kind='symlink', size=0, target=os.readlink(path), executable=False)
        elif stat.S_ISDIR(info.st_mode):
            item = dict(path=name, kind='directory', size=0, executable=False)
        elif stat.S_ISREG(info.st_mode):
            item = dict(path=name, kind='file', size=info.st_size,
                        sha256=hashlib.sha256(path.read_bytes()).hexdigest(), executable=bool(info.st_mode & 0o111))
        else:
            raise ValueError('unsupported payload type')
        records.append(item)
    for role in ['leaf', 'leaf-mcp-adapter', 'leaf-update-helper']:
        binary = source / ('Contents/MacOS/' + role if platform == 'darwin' else role + '.exe')
        marker = ('LEAF_UPDATE_BINARY_IDENTITY_V1\0Leaf\0studio.leaf.editor\0' + version + '\0' + role + '\0').encode()
        if marker not in binary.read_bytes():
            raise ValueError('compiled payload version or role mismatch')
    metadata = dict(schema=1, product='Leaf', identifier='studio.leaf.editor', version=version,
                    platform=platform, arch=arch, root=root, inventory=records)
    data = json.dumps(metadata, ensure_ascii=False, separators=(',', ':')).encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as raw:
        with tarfile.open(fileobj=raw, mode='w:gz', format=tarfile.GNU_FORMAT) as archive:
            for (path, name), item in zip(paths, records):
                entry = tarfile.TarInfo(name)
                entry.uid = entry.gid = entry.mtime = 0
                entry.mode = 0o700 if item['kind'] == 'directory' or item['executable'] else 0o600
                if item['kind'] == 'directory':
                    entry.type = tarfile.DIRTYPE
                    archive.addfile(entry)
                elif item['kind'] == 'symlink':
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = item['target']
                    archive.addfile(entry)
                else:
                    entry.size = item['size']
                    with path.open('rb') as file:
                        archive.addfile(entry, file)
            entry = tarfile.TarInfo('leaf-update.json')
            entry.mode = 0o600
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return dict(file=output.name, sha256=hashlib.sha256(output.read_bytes()).hexdigest(), entries=len(records))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source', 'output', 'version']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--platform', choices=['darwin', 'windows'], required=True)
    parser.add_argument('--arch', choices=['aarch64', 'x86_64'], required=True)
    args = parser.parse_args()
    print(json.dumps(build(**vars(args))))
