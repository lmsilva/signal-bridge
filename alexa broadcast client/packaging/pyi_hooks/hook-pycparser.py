# Modern pycparser embeds lexer/parser tables; lextab/yacctab modules no longer
# ship as importable files. The stock contrib hook still requests them and
# PyInstaller prints "Hidden import not found" warnings on every Windows build.
hiddenimports = []
