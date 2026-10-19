"""Generating a chain's frames with Deforum, set up for the shot.

The frames of a chain made from a video are the motion. They are laid on a flat backdrop and given to Deforum
as its Video Input and as ControlNet's pose video, so every frame it draws has the figure exactly where the
motion chain has it, on a backdrop whose colour is known. And:
- Deforum's own camera stands still (the 3D camera is Time Strata's). DeforumationQT is left out of these frames:
  it would move the camera and set the steps. Its switch is turned off in memory only for the job and put back
  when the job ends; its file is never written.
- The seed is fixed, so neighbouring frames, which stand a few centimetres apart in the chain, share their
  texture and the chain reads as one body.
- The stages of the prompt are keyframes at their frames; Deforum blends each into the next (a baby growing old).
- The cut takes the backdrop away by its colour, keeps the motion figure's body solid and nothing far from it.
- Deforum writes into the chain's own folder, not into the usual outputs.
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid

import cv2
import numpy as np
from PIL import Image

from . import chain, compat, cut, jobs, media, store

DEFAULTS = {
    "prompt": "", "stages": [], "negative": "blurry, deformed, extra limbs, text, watermark, nsfw, nude",
    "prefix": "<lora:LCM_SD15:1>", "sampler": "LCM", "steps": 8, "cfg": 1.5, "strength": 0.3, "pose": 0.9,
    "seed": 1234, "background": "#808080", "first": 0, "last": None, "every": 1, "checkpoint": None,
}

# The backdrop is laid flat by Time Strata itself, so every stage asks for it to stay flat: a drawn floor or a
# shadow under the feet is cut as part of the figure in some frames and not in others, and in the stack that
# turns into a grey band at the chain's feet (measured on the first real render: almost all the fog was in the
# bottom eighth of the frames).
BACKDROP_WORDS = "isolated on a plain flat grey background"
NOT_A_ROOM = "floor, shadow, reflection, horizon line, gradient background, room, scenery"
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


# --- Deforum, found and borrowed ----------------------------------------------------------------------------------

def _deforum_dir():
    return compat.deforum_dir()


def _ensure_paths():
    folder = _deforum_dir()
    if not folder:
        raise jobs.JobError("A compatible Deforum extension is not installed or enabled")
    for path in (os.path.join(folder, "scripts"), os.path.join(folder, "scripts", "deforum_helpers", "src")):
        if path not in sys.path:
            sys.path.append(path)
    return folder


def _switch():
    """Deforum's DeforumationQT switch module, as Deforum itself loaded it."""
    for name, module in list(sys.modules.items()):
        if name.endswith("deforumation_switch") and hasattr(module, "_load"):
            return module
    try:
        from deforum_helpers import deforumation_switch
        return deforumation_switch
    except Exception:
        return None


class _WithoutDeforumation:
    """DeforumationQT off for one render, in memory only; afterwards it is exactly as it was."""

    def __enter__(self):
        self.module = _switch()
        self.state = self.module._load() if self.module else None
        self.had = "enabled" in self.state if self.state is not None else False
        self.before = self.state.get("enabled") if self.state is not None else None
        if self.state is not None:
            self.state["enabled"] = False
        return self

    def __exit__(self, *_):
        if self.state is not None:
            if self.had:
                self.state["enabled"] = self.before
            else:
                self.state.pop("enabled", None)


def last_settings():
    """The sampler, steps and CFG of the user's newest Deforum render (its settings file beside its frames)."""
    try:
        from modules import shared
        folders = [shared.opts.outdir_samples, shared.opts.outdir_img2img_samples]
    except Exception:
        folders = []
    newest, when = None, 0
    for folder in [f for f in folders if f]:
        for path in glob.glob(os.path.join(folder, "Deforum_*", "*_settings.txt")):
            moment = os.path.getmtime(path)
            if moment > when:
                newest, when = path, moment
    if not newest:
        return {}
    try:
        with open(newest, "r", encoding="utf8") as file:
            data = json.load(file)
    except Exception:
        return {}
    cfg = str(data.get("cfg_scale_schedule") or "")
    found = {"sampler": data.get("sampler"), "steps": data.get("steps"), "checkpoint": data.get("sd_model_name"), "from": newest}
    try:
        found["cfg"] = float(cfg.split("(")[1].split(")")[0])
    except Exception:
        pass
    return {k: v for k, v in found.items() if v is not None}


def available():
    try:
        from lib_controlnet import global_state
        pose = [n for n in global_state.get_all_controlnet_names() if "openpose" in n.lower()]
        pose.sort(key=lambda n: (0 if "v11" in n.lower() else 1, len(n)))
        modules = global_state.get_all_preprocessor_names() if hasattr(global_state, "get_all_preprocessor_names") else []
    except Exception:
        pose, modules = [], []
    preprocessor = next((m for m in ("dw_openpose_full", "openpose_full", "openpose") if m in modules), "openpose_full")
    return {"deforum": bool(_deforum_dir()), "pose_model": pose[0] if pose else None, "pose_preprocessor": preprocessor,
            "last": last_settings()}


# --- the motion clip ----------------------------------------------------------------------------------------------

def _hex(text):
    text = str(text or "#808080").lstrip("#")
    return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))


def _up64(n):
    return int((int(n) + 63) // 64 * 64)


def _motion(job, project, source, folder, options):
    """The motion chain's frames on the backdrop, padded to Deforum's sizes, as a video; and each frame's
    figure (its alpha, padded the same way) kept as the prior of the cut."""
    record = store.read_chain(project, source)
    if not record or not record.get("make"):
        raise jobs.JobError("the motion chain has not been made yet")
    frames = list(range(int(options["first"] or 0), int(options["last"] if options["last"] is not None else record["frames"] - 1) + 1,
                        max(1, int(options["every"] or 1))))
    frames = [k for k in frames if 0 <= k < record["frames"]]
    if len(frames) < 2:
        raise jobs.JobError("choose at least two frames of the motion chain")
    w, h = record["width"], record["height"]
    W, H = _up64(w), _up64(h)
    left, top = (W - w) // 2, H - h            # the padding goes above, so the ground line keeps its distance from the bottom
    backdrop = _hex(options["background"])
    prior_folder = os.path.join(folder, "prior")
    shutil.rmtree(prior_folder, ignore_errors=True)
    os.makedirs(prior_folder)
    fps = float(record.get("fps") or 24) / max(1, int(options["every"] or 1))

    def writer(path):
        command = [media.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                   "-s", f"{W}x{H}", "-r", f"{fps:.6f}", "-i", "-", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", path]
        return subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=_NO_WINDOW)

    # the motion, and where Deforum may paint: the motion figure grown a little (a skirt swings out, hair
    # flies); everything else keeps the flat backdrop exactly, so no floor or shadow can be drawn there
    video, mask = os.path.join(folder, "motion.mp4"), os.path.join(folder, "mask.mp4")
    processes = [writer(video), writer(mask)]
    grow = cut._disk(0.025 * H)
    source_folder = os.path.join(store.chain_dir(project, source), record["make"])
    try:
        for n, k in enumerate(frames):
            picture = Image.open(os.path.join(source_folder, f"{k:06d}.webp")).convert("RGBA")
            canvas = Image.new("RGB", (W, H), backdrop)
            canvas.paste(picture, (left, top), picture)
            alpha = Image.new("L", (W, H), 0)
            alpha.paste(picture.split()[3], (left, top))
            alpha.save(os.path.join(prior_folder, f"{n:06d}.png"))
            paint = cv2.dilate((np.asarray(alpha) >= 128).astype(np.uint8) * 255, grow)
            processes[0].stdin.write(np.asarray(canvas).tobytes())
            processes[1].stdin.write(np.repeat(paint[..., None], 3, axis=2).tobytes())
            if n % 10 == 0:
                job.step(f"laying out the motion: frame {n + 1} of {len(frames)}", 0.01 + 0.04 * n / len(frames),
                         jobs.preview_of(canvas))
    finally:
        for process in processes:
            process.stdin.close()
            error = process.stderr.read().decode("utf8", "replace")
            if process.wait() != 0:
                raise jobs.JobError(f"the motion clip could not be written: {error[-300:]}")
    return {"video": video, "mask": mask, "frames": len(frames), "width": W, "height": H, "fps": fps, "record": record}


# --- Deforum's settings ------------------------------------------------------------------------------------------

def _prompts(options, count):
    """The stages of the prompt as Deforum's keyframes: {frame: prompt}. A stage's `at` is a share of the chain
    (0..1) or, above 1, a frame number."""
    prefix = str(options.get("prefix") or "").strip()
    negative = ", ".join(p for p in (str(options.get("negative") or "").strip(), NOT_A_ROOM) if p)

    def full(text):
        text = " ".join(p for p in (prefix, str(text or "").strip()) if p)
        return f"{text}, {BACKDROP_WORDS} --neg {negative}"

    stages = [s for s in (options.get("stages") or []) if str(s.get("text") or "").strip()]
    if not stages:
        return {"0": full(options.get("prompt") or "a person")}
    keyed = {}
    for stage in stages:
        at = float(stage.get("at") or 0)
        frame = int(round(at * (count - 1))) if at <= 1 else int(at)
        keyed[str(max(0, min(count - 1, frame)))] = full(stage["text"])
    if "0" not in keyed:
        keyed["0"] = keyed[min(keyed, key=int)]
    return dict(sorted(keyed.items(), key=lambda kv: int(kv[0])))


def settings(base, motion, options, outdir_name):
    available_now = available()
    pose_model = available_now["pose_model"]
    data = dict(base)
    data.update({
        "animation_mode": "Video Input", "video_init_path": motion["video"], "extract_nth_frame": 1,
        "extract_from_frame": 0, "extract_to_frame": -1, "overwrite_extracted_frames": True,
        # only the figure's place is painted; the backdrop is put back as it was (white = paint)
        "use_mask_video": True, "video_mask_path": motion["mask"], "invert_mask": False, "overlay_mask": True,
        "mask_overlay_blur": 4, "mask_contrast_adjust": 1.0, "mask_brightness_adjust": 1.0, "fill": 1,
        "full_res_mask": False, "use_noise_mask": False, "use_alpha_as_mask": False,
        "hybrid_motion": "None", "hybrid_composite": "None",
        "max_frames": motion["frames"], "W": motion["width"], "H": motion["height"],
        "seed": int(options["seed"]), "seed_behavior": "fixed", "sampler": options["sampler"], "steps": int(options["steps"]),
        "enable_steps_scheduling": False, "cfg_scale_schedule": f"0: ({float(options['cfg'])})",
        "strength_schedule": f"0: ({float(options['strength'])})", "noise_schedule": "0: (0)",
        "color_coherence": "None", "diffusion_cadence": 1, "fps": max(1, int(round(motion["fps"]))),
        "prompts": _prompts(options, motion["frames"]), "animation_prompts": "", "positive_prompts": "", "negative_prompts": "",
        "batch_name": outdir_name, "skip_video_creation": True, "make_gif": False, "frame_interpolation_engine": "None",
        "r_upscale_video": False, "store_frames_in_ram": False, "motion_preview_mode": False, "save_depth_maps": False,
        "use_init": False, "use_mask": True, "show_info_on_ui": False, "resume_from_timestring": False,     # (Deforum masks only with use_mask)
        "enable_checkpoint_scheduling": False, "enable_clipskip_scheduling": False, "enable_subseed_scheduling": False,
        "enable_sampler_scheduling": False, "enable_perspective_flip": False, "anti_blur_amount_schedule": "0: (0)",
        "amount_schedule": "0: (0)", "zoom": "0: (1.0)", "angle": "0: (0)", "translation_x": "0: (0)", "translation_y": "0: (0)",
        "translation_z": "0: (0)", "rotation_3d_x": "0: (0)", "rotation_3d_y": "0: (0)", "rotation_3d_z": "0: (0)",
        "cn_1_enabled": bool(pose_model and float(options["pose"]) > 0), "cn_1_module": available_now["pose_preprocessor"],
        "cn_1_model": pose_model or "None", "cn_1_weight": f"0:({float(options['pose'])})", "cn_1_vid_path": motion["video"],
        "cn_1_overwrite_frames": True, "cn_1_pixel_perfect": True, "cn_1_resize_mode": "Inner Fit (Scale to Fit)",
        "cn_1_control_mode": "Balanced", "cn_1_guidance_start": "0:(0.0)", "cn_1_guidance_end": "0:(1.0)",
        "cn_1_loopback_mode": False, "cn_1_low_vram": False,
    })
    # every other unit, complete and off: Deforum reads the schedules of as many units as Forge is set up for
    # (6 on this Forge), and a unit its settings file does not name comes in with empty schedules and stops it
    try:
        from modules import shared
        units = int(shared.opts.data.get("control_net_unit_count", shared.opts.data.get("control_net_max_models_num", 5)) or 5)
    except Exception:
        units = 5
    off = {"enabled": False, "module": "none", "model": "None", "weight": "0:(1)", "guidance_start": "0:(0.0)",
           "guidance_end": "0:(1.0)", "vid_path": "", "mask_vid_path": "", "overwrite_frames": True, "low_vram": False,
           "pixel_perfect": False, "processor_res": 64, "threshold_a": 64, "threshold_b": 64,
           "resize_mode": "Inner Fit (Scale to Fit)", "control_mode": "Balanced", "loopback_mode": False}
    for n in range(2, max(5, units) + 1):
        for key, value in off.items():
            data[f"cn_{n}_{key}"] = value
    return data


def _base_settings(folder):
    with open(os.path.join(folder, "scripts", "default_settings.txt"), "r", encoding="utf8") as file:
        return json.load(file)


class _File:
    """What Deforum's batch runner takes for a settings file: something with a name."""

    def __init__(self, name):
        self.name = name


class _Share:
    """A job seen through a part of its progress (a step that runs from `a` to `b` of the whole)."""

    def __init__(self, job, a, b):
        self.job, self.a, self.b = job, a, b

    def step(self, stage=None, progress=None, preview=None):
        self.job.step(stage, None if progress is None else self.a + (self.b - self.a) * progress, preview)

    def __getattr__(self, name):
        return getattr(self.job, name)


def _watch(job, done, total):
    """Deforum's progress and its frame, while it draws (it reports through Forge's shared state)."""
    from modules import shared
    last_preview = 0
    while not done.is_set():
        state = shared.state
        share = 0.0
        if state.job_count and state.job_count > 0:
            share = state.job_no / state.job_count
            if state.sampling_steps:
                share += state.sampling_step / state.sampling_steps / state.job_count
        job.progress = 0.06 + 0.84 * min(max(share, 0.0), 1.0)
        job.stage = f"Deforum is drawing frame {min(total, int(state.job_no) + 1)} of {total}"
        if time.time() - last_preview > 2:
            try:
                state.set_current_image()
                if state.current_image is not None:
                    job.preview = jobs.preview_of(state.current_image)
            except Exception:
                pass
            last_preview = time.time()
        done.wait(0.5)


@jobs.handler("deforum")
def generate(job):
    """params: project, source (the motion chain), chain (the new chain), options (see DEFAULTS)"""
    params = job.params
    project = store.clean_name(params["project"])
    source = store.clean_id(params["source"], "chain id")
    target = store.clean_id(params["chain"], "chain id")
    if source == target:
        raise jobs.JobError("the new chain must be another chain than its motion")
    options = dict(DEFAULTS)
    options.update({k: v for k, v in (params.get("options") or {}).items() if k in DEFAULTS and v is not None})
    deforum_folder = _ensure_paths()
    folder = store.chain_dir(project, target, create=True)

    motion = _motion(job, project, source, folder, options)
    out_root = os.path.join(folder, "deforum")
    shutil.rmtree(out_root, ignore_errors=True)
    os.makedirs(out_root)
    name = f"TimeStrata_{target}"
    data = settings(_base_settings(deforum_folder), motion, options, name)
    settings_path = os.path.join(folder, "deforum_settings.json")
    with open(settings_path, "w", encoding="utf8") as file:
        json.dump(data, file, ensure_ascii=False, indent=1)

    import deforum_api
    from modules import shared
    from modules.call_queue import queue_lock
    batch_id = f"timestrata({uuid.uuid4().hex[:8]})"
    job_id = f"{batch_id}-0"
    tracker = deforum_api.JobStatusTracker()
    tracker.accept_job(batch_id=batch_id, job_id=job_id, deforum_settings=[data], options_overrides={})
    job.on_cancel = lambda: shared.state.interrupt()
    job.step("waiting for Forge (another drawing may be running)", 0.05)
    done = threading.Event()
    watcher = threading.Thread(target=_watch, args=(job, done, motion["frames"]), daemon=True)
    with queue_lock:
        if job.cancel_asked:
            raise jobs.Cancelled()
        watcher.start()
        try:
            with _WithoutDeforumation():
                deforum_api.run_deforum_batch(batch_id, [job_id], [_File(settings_path)], {"outdir_samples": out_root})
        finally:
            done.set()
            watcher.join(timeout=5)
    if job.cancel_asked or shared.state.interrupted:
        raise jobs.Cancelled()
    status = tracker.get(job_id)
    outdir = getattr(status, "outdir", None) or os.path.join(out_root, name)
    stamp = getattr(status, "timestring", None)
    drawn = sorted(p for p in glob.glob(os.path.join(outdir, f"{stamp or '*'}_*.png")) if "_depth_" not in os.path.basename(p))
    if not drawn:
        message = getattr(status, "message", None)
        raise jobs.JobError(f"Deforum drew no frames{': ' + str(message) if message else ''} (see Forge's console)")

    # the drawn frames become the new chain's source, in order
    pictures = os.path.join(folder, "source")
    shutil.rmtree(pictures, ignore_errors=True)
    os.makedirs(pictures)
    for n, path in enumerate(drawn[:motion["frames"]]):
        shutil.copyfile(path, os.path.join(pictures, f"{n:06d}.png"))
    shutil.rmtree(out_root, ignore_errors=True)         # Deforum's own copies and its extracted input frames

    prior_folder = os.path.join(folder, "prior")

    def priors(n, shape):
        path = os.path.join(prior_folder, f"{n:06d}.png")
        if not os.path.isfile(path):
            return None
        prior = np.asarray(Image.open(path).convert("L"), np.float32) / 255.0
        if prior.shape != tuple(shape):
            prior = np.asarray(Image.fromarray((prior * 255).astype(np.uint8)).resize((shape[1], shape[0]), Image.BILINEAR), np.float32) / 255.0
        return prior

    record = motion["record"]
    cut_options = chain._options({"options": {
        "matte": "key", "key_colour": str(options["background"]), "height": record["height"],
        "align": "centre", "scale": "steady", "figure": (record.get("options") or {}).get("figure", 0.84),
        "baseline": (record.get("options") or {}).get("baseline", 0.95), "max_frames": len(drawn),
        "prior_reach": 0.012,       # the drawn figure follows the motion closely (its pose and its picture)
    }})
    result = chain.build(_Share(job, 0.9, 1.0), project, target,
                         {"kind": "pictures", "path": f"chains/{target}/source", "fps": motion["fps"]},
                         cut_options, priors=priors,
                         extra={"deforum": {"from": source, "options": options, "settings": "deforum_settings.json"}})
    result["from"] = source
    return result
