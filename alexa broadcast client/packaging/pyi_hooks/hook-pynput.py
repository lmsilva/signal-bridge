# Freeze only Windows pynput backends (stock hook collect_submodules pulls
# darwin/xorg/uinput and clutters the build log on Windows).
from PyInstaller.utils.hooks import collect_submodules

_SKIP = frozenset({
    'android', 'cocoa', 'gtk', 'qt', 'darwin', 'darwin_vks', 'uinput', 'xorg',
})


def _windows_only(name: str) -> bool:
    return not any(part.lstrip('_') in _SKIP for part in name.lower().split('.'))


hiddenimports = collect_submodules('pynput', filter=_windows_only)
