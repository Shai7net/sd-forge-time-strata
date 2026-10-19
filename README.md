# Time Strata

### Turn motion into a sculpture of time.

**Time Strata** is a video art extension for Stable Diffusion WebUI Forge. It extracts a moving subject from a video or image sequence, arranges its frames as layers in a 3D scene, and lets you animate a camera through the result.

A dance becomes a winding ribbon of movement. A gesture becomes a tunnel. With the optional Deforum workflow, one performance can evolve through different ages, characters or visual styles along the same path.

<p align="center">
  <a href="https://github.com/Shai7net/sd-forge-time-strata/blob/main/docs/media/one-dance-sixty-years-en.mp4">
    <img src="docs/media/one-dance-sixty-years.jpg" alt="One Dance, Sixty Years: successive layers of dancers arranged along a curved path" width="320">
  </a>
  <br>
  <strong>One Dance, Sixty Years</strong><br>
  <a href="https://github.com/Shai7net/sd-forge-time-strata/raw/refs/heads/main/docs/media/one-dance-sixty-years-en.mp4">Watch or download the example · 16 seconds · 1080 × 1920 · 30 fps</a>
</p>

## Features

- **Video and image sequences.** Import a video, a ZIP of frames, or multiple images, including transparent PNGs.
- **Clean subject extraction.** Use existing transparency, colour keying, BiRefNet, rembg models or optional Robust Video Matting. Alpha cleanup, edge decontamination and body alignment help keep stacked frames clear.
- **Sculpt motion in space.** Arrange layers along a line, arc, S-curve, rising path or spiral. Adjust spacing, orientation and twist. Reuse a chain's frames in another arrangement.
- **Animate time.** Display all layers at once, consume the chain as the present advances, or grow a trail behind the present.
- **Direct the camera.** Use presets, edit camera keys, follow the moving present, or turn a freely chosen view into a keyframe.
- **Slice through the scene.** Animate a cutting plane to reveal a cross-section through the layers.
- **Build a setting.** Choose sky and ground colours or upload a 360° panorama. Optional Simulation 360 integration can copy an existing panorama into your project.
- **Transform the performer.** Optional Deforum generation uses a source chain as motion guidance and supports prompt stages along the sequence.
- **Export with music.** Record H.264 MP4, optional NVIDIA NVENC MP4 or VP9 WebM, with portrait, landscape and square sizes and optional supersampling.
- **Work locally.** Projects and exports stay on your machine. The scene runs in your browser with WebGL2; Python handles frame preparation and video encoding.

The visual technique is inspired by video strata and David Daniels' Strata-Cut. The scene uses layered image planes: camera movement, spacing and transparency create its sculptural appearance.

## Forge compatibility

Time Strata targets the Forge family through shared extension callbacks, a small Gradio HTML host and a browser-rendered editor. Its memory adapter supports both Forge backend layouts.

| Host | Integration | Verification status |
| --- | --- | --- |
| Legacy Forge | `ldm_patched.modules.model_management` | Adapter and image-processing tests pass locally; example supplied from the author's installation |
| [Forge / Forge 2 (V2)](https://github.com/lllyasviel/stable-diffusion-webui-forge) | `backend.memory_management` | Upstream API checked; adapter tested; full host render still needs validation |
| [Forge Neo](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo) | `backend.memory_management` and shared callbacks | Upstream API checked; adapter tested; full host render still needs validation |

**Compatibility is feature-dependent.** Importing footage, arranging layers and recording do not require a diffusion checkpoint or Deforum. AI generation additionally requires a working combination of Deforum, ControlNet, checkpoint, pose model and sampler in your Forge installation. A model supported by Forge itself does not automatically have Deforum support.

The installer adds missing essentials and keeps existing packages. Torch, CUDA, Gradio and ONNX Runtime are managed by your Forge installation. Automated tests exercise the standalone core and integration adapters; they do not launch each Forge variant. See [compatibility notes](docs/COMPATIBILITY.md) for verification scope and a host test checklist.

## Installation

### Through Forge

1. Open **Extensions → Install from URL**.
2. Paste `https://github.com/Shai7net/sd-forge-time-strata` and install.
3. **Completely stop and restart Forge** so its extension installer runs.
4. Open the **Time Strata** tab. Refresh the browser if its assets are stale.

### With Git

Run this from the folder containing Forge's `webui.py`:

```bash
git clone https://github.com/Shai7net/sd-forge-time-strata.git extensions/sd-forge-time-strata
```

Restart Forge. A portable installation may call this folder `webui`; use that folder rather than the outer launcher directory.

### Requirements

- A working Forge-family installation and its own Python environment.
- A modern browser with **WebGL2** and hardware acceleration enabled.
- NumPy, Pillow, OpenCV and `imageio-ffmpeg`, installed automatically only when their imports are missing. FastAPI and Gradio come from Forge.
- Internet access for initial packages and requested model downloads. Video decoding and encoding use the FFmpeg executable provided by `imageio-ffmpeg`.

Start with transparent images or a video on a plain backdrop: these workflows need no AI matting packages. General-background removal requires additional packages; see [optional model setup](docs/COMPATIBILITY.md#optional-background-removal).

## Your first scene

1. **Create a project.** Choose **New project** and enter a name.
2. **Add footage.** In **Chains**, add a video or image sequence. A clear subject, complete body and steady camera make a useful starting point.
3. **Choose the cut.** Use the source's alpha channel, colour keying for a plain backdrop, or a matting model. Limit the source interval and frame count for the first attempt.
4. **Build the chain.** Wait for extraction and alignment. Inspect the preview and any suspect frames before increasing the sequence length.
5. **Shape the path.** Adjust the spine, spacing and orientation. Choose how the present moves through the chain.
6. **Set the camera.** Try a preset, then adjust the keys. Drag to orbit, scroll to change distance, and right-drag or Shift-drag to pan. Double-click returns to the keyed view.
7. **Choose the world and shot.** Set the background, duration and output dimensions. Use the planner to balance frame count, spacing and camera speed.
8. **Record.** Open **Record**, choose a format and optional music, then click **Record**. Keep the page open until recording finishes.

Projects save automatically. Default locations, relative to Forge's data directory:

```text
time-strata/<project>/          Project document, uploads and prepared chains
models/time-strata/             Downloaded matting models
output/time-strata/             Exported videos
```

Change project and export locations under **Settings → Time Strata**. Back up the entire project folder, including uploads and chains; the JSON document alone does not contain the media.

## Optional: one dance across a lifetime

The example demonstrates a creative use of Deforum: preserve the movement of a performance while changing its appearance along the timeline.

1. Build a clean motion chain from your source video.
2. Install and enable a Forge-compatible Deforum extension exposing its Python API, plus compatible ControlNet/OpenPose assets.
3. In the generation controls, choose the motion chain and a **new** destination chain.
4. Choose a checkpoint, sampler, seed and settings that work in your Deforum setup. The supplied LCM/SD 1.5 defaults assume matching assets; adjust or remove the LoRA prefix if those assets are absent.
5. Add prompt stages for the progression, then generate and inspect the cutouts.
6. Arrange the generated chain, animate the camera and record the scene.

Time Strata prepares Video Input and pose guidance, uses a flat backdrop, and fixes Deforum's camera. Its direct Python integration does not require `--deforum-api`. A compatible DeforumationQT switch, when present, is disabled in memory during the job and restored afterwards.

## Performance and troubleshooting

| Symptom | What to try |
| --- | --- |
| Tab missing | Enable the extension, fully restart Forge and check its console for import or installation errors. |
| Blank 3D view | Enable browser hardware acceleration and WebGL2. Refresh and inspect the browser console for `[Time Strata]` errors. |
| Haze or walls around the subject | Improve the matte and remove faint background alpha. Residual opacity accumulates across hundreds of layers. |
| Flickering silhouette | Try another matting method, improve the backdrop and review suspect frames. |
| VRAM pressure | Reduce resolution, chain length or supersampling. Prefer a lighter matting model and avoid simultaneous image generation while extracting subjects. |
| Missing ONNX/rembg module | Follow optional model setup using Forge's Python. Alpha and colour-key workflows can be used immediately. |
| NVENC export fails | Select ordinary **MP4**. NVENC requires a supported NVIDIA GPU, driver and FFmpeg encoder. |
| Deforum unavailable | Enable a compatible extension with `scripts/deforum_api.py`; check the checkpoint, pose model and sampler. |
| Folder button on Linux/macOS | Automatic Explorer opening currently applies to Windows. Open the configured path manually. |

Extraction uses ONNX Runtime's CUDA provider when available, with CPU as fallback. Speed and memory use depend on the model, provider, footage and hardware. Full-size BiRefNet models can be substantially heavier than the lite variant. RVM files must be supplied manually.

## API and development

Routes are available at **`/time-strata`** on Forge's own server. No additional server or `--api` flag is needed for these routes. See the [API guide](docs/API.md) for JavaScript, Python and curl examples.

Run standalone tests from this extension's root:

```bash
node --test tests/core.test.js
python -m unittest discover -s tests -p "test_*.py"
```

Use Forge's Python, or a separate environment with `numpy`, `opencv-python-headless`, `Pillow`, `fastapi`, `httpx` and `imageio-ffmpeg`. Tests use temporary projects and do not download models. CI covers the core on Node.js and Python on Windows and Linux; Forge UI and Deforum validation are separate manual checks.

For bug reports, include the Forge repository/branch/commit, OS, Python version, GPU, matting method, reproduction steps and relevant error. Remove private paths and prompts from shared logs.

## Credits and license

Created by **[Shai7net](https://github.com/Shai7net)** with development assistance from Claude. Publication preparation and Forge compatibility adapters were assisted by Codex.

Thanks to the Forge and Forge Neo maintainers and the creators of Deforum, ControlNet, BiRefNet, rembg, Robust Video Matting, FFmpeg and the other libraries used by the project.

Extension source code is available under the [MIT License](LICENSE). The example video and preview are demonstration media, excluded from the source-code license. Models, checkpoints, footage, music and third-party software retain their respective licenses.
