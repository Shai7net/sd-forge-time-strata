"""Small host adapters shared by legacy Forge, Forge 2 and Forge Neo."""

import importlib
import os
import sys


def free_graphics_memory():
    """Use the host's loaded memory manager before trying other Forge layouts."""
    names = ("backend.memory_management", "ldm_patched.modules.model_management")
    ordered = [name for name in names if name in sys.modules]
    ordered += [name for name in names if name not in ordered]
    errors = []
    for name in ordered:
        try:
            manager = importlib.import_module(name)
        except ImportError:
            continue
        try:
            manager.unload_all_models()
            manager.soft_empty_cache()
            return True
        except Exception as error:
            errors.append(f"{name}: {type(error).__name__}: {error}")
    detail = "; ".join(errors) or "no supported Forge memory manager found"
    print(f"[Time Strata] could not free graphics memory: {detail}")
    return False


def deforum_dir():
    """Find an enabled Deforum installation, including custom folder names."""
    try:
        from modules import extensions
        for extension in extensions.active():
            folder = extension.path
            if os.path.isfile(os.path.join(folder, "scripts", "deforum_api.py")):
                return folder
        # Respect disabled extensions when the host has an extension registry.
        return None
    except (ImportError, AttributeError):
        pass
    try:
        from modules import paths
        webui = paths.data_path
    except ImportError:
        webui = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    for name in ("sd-forge-deforum", "sd-webui-deforum"):
        folder = os.path.join(webui, "extensions", name)
        if os.path.isfile(os.path.join(folder, "scripts", "deforum_api.py")):
            return folder
    return None
