# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the MIDI Player IPC sidecar.
#
#   Build:  python -m PyInstaller --noconfirm --clean python-engine/ipc_main.spec
#   Output: dist/ipc_main.exe  (single-file, ~12-15 MB)
#
# The build is invoked from the project root by build-portable.bat, which then
# copies dist/ipc_main.exe into python-engine/ so the Electron app picks it up
# automatically (main.js checks for the exe before falling back to Python).

import os
from PyInstaller.utils.hooks import collect_all

# pynput ships per-platform keyboard backends loaded via importlib —
# collect_all walks the package and adds them as hidden imports.
pynput_datas, pynput_binaries, pynput_hidden = collect_all('pynput')

block_cipher = None

a = Analysis(
    [os.path.join(os.path.dirname(os.path.abspath(SPEC)), 'ipc_main.py')],
    pathex=[os.path.dirname(os.path.abspath(SPEC))],
    binaries=pynput_binaries,
    datas=[
        # bundle mappings into the .exe; ipc_main.py finds them via sys._MEIPASS
        (os.path.join(os.path.dirname(os.path.abspath(SPEC)), 'mappings'), 'mappings'),
    ] + pynput_datas,
    hiddenimports=[
        'win32timezone',          # pywin32 transitive
    ] + pynput_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Big deps the IPC sidecar doesn't touch. The CLI display_thread uses
        # pygame, but it's only imported inside that function and ipc_main.py
        # never calls it.
        'pygame',
        'tkinter',
        'numpy',
        'matplotlib',
        'IPython',
        'jupyter',
        'pandas',
        'PIL',
        'pytest',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='ipc_main',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                    # UPX often trips antivirus heuristics
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,                 # the console IS the stdio IPC channel
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
