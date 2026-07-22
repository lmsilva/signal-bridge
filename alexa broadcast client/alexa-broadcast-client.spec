# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

# pywebview (Edge WebView2) needs its platform submodules plus bundled
# .NET assemblies (WebView2Loader / Microsoft.Web.WebView2.*).
webview_hiddenimports = (
    collect_submodules('webview')
    + ['clr', 'clr_loader', 'pythonnet']
)
webview_datas = (
    collect_data_files('webview')
    + collect_data_files('clr_loader')
    + collect_data_files('pythonnet')
)

a = Analysis(
    ['src/main.py'],
    pathex=['.'],
    binaries=[],
    datas=[('config.json', '.'), ('assets', 'assets')],
    hiddenimports=[
        'pystray',
        'pystray._win32',
        'PIL',
        'PIL.Image',
        'PIL.ImageDraw',
        'pynput',
        'pynput.keyboard',
        'pynput.mouse',
        'src.config',
        'src.display_announce',
        'src.display_identity',
        'src.display_panels',
        'src.input_control',
        'src.listener',
        'src.main',
        'src.message_scroll',
        'src.overlay',
        'src.paths',
        'src.payload_utils',
        'src.tray_app',
        'src.weather_fetch',
        'src.web_overlay',
        'ssl',
        'urllib.request',
        'urllib.parse',
        'urllib.error',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='alexa-broadcast-client',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# WebView2 host for the persistent web display mode (spawned on web.open).
host_a = Analysis(
    ['src/webview_host.py'],
    pathex=['.'],
    binaries=[],
    datas=webview_datas,
    hiddenimports=webview_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

host_pyz = PYZ(host_a.pure, host_a.zipped_data, cipher=block_cipher)

host_exe = EXE(
    host_pyz,
    host_a.scripts,
    [],
    exclude_binaries=True,
    name='webview-host',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    host_exe,
    host_a.binaries,
    host_a.zipfiles,
    host_a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='alexa broadcast client',
)

test_a = Analysis(
    ['test/send_test.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

test_pyz = PYZ(test_a.pure, test_a.zipped_data, cipher=block_cipher)

test_exe = EXE(
    test_pyz,
    test_a.scripts,
    test_a.binaries,
    test_a.zipfiles,
    test_a.datas,
    [],
    name='send-test',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    onefile=True,
)
