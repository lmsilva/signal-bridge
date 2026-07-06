import shutil
import sys
from pathlib import Path


def is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def app_root() -> Path:
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def bundled_resource(name: str) -> Path:
    if is_frozen():
        return Path(sys._MEIPASS) / name
    return app_root() / name


def asset_path(name: str) -> Path:
    external = app_root() / "assets" / name
    if external.exists():
        return external
    return bundled_resource(Path("assets") / name)


def ensure_config_file() -> Path:
    config_path = app_root() / "config.json"
    if config_path.exists():
        return config_path

    default_path = bundled_resource("config.json")
    if default_path.exists() and default_path.resolve() != config_path.resolve():
        shutil.copy2(default_path, config_path)

    return config_path
