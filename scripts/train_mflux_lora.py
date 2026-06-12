#!/usr/bin/env python3
"""mflux FLUX.1-dev LoRA training wrapper (PortOS).

Wraps mflux's own DreamBooth training CLI in a subprocess and translates
its native output into the PortOS trainer line protocol (see
train_flux2_lora.py header / server/services/loraTraining/progress.js).
We deliberately do NOT import mflux's training internals in-process —
their API churns across versions; the CLI + train-config JSON is the
stable-ish surface (same wrap-don't-import strategy as generate_wan22.py).

Entrypoint probing (mflux moved this across versions):
  1. <venv python> -m mflux.dreambooth --train-config <json>
  2. mflux-train (console script next to the interpreter)

Artifacts: mflux writes checkpoints (zips) + validation images into the
config's save.output_path (our <runDir>/checkpoints). A watcher thread
surfaces new checkpoints as CHECKPOINT: lines and copies validation PNGs
into <runDir>/samples for SAMPLE: lines. On success, the newest adapter
.safetensors (extracted from the newest checkpoint zip when necessary) is
reported via RESULT: JSON.

SIGTERM → forwarded to the mflux child; exit 143 after it stops.
"""

import argparse
import json
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path

CHILD = None
STOP_REQUESTED = False


def log(msg: str) -> None:
    print(msg, flush=True)


def _on_sigterm(_sig, _frame):
    global STOP_REQUESTED
    STOP_REQUESTED = True
    log("STATUS:cancel requested — stopping mflux trainer")
    if CHILD and CHILD.poll() is None:
        CHILD.terminate()


signal.signal(signal.SIGTERM, _on_sigterm)


def parse_args():
    p = argparse.ArgumentParser(description="mflux LoRA training wrapper")
    p.add_argument("--train-config", required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--total-steps", type=int, default=1000,
                   help="step budget for progress mapping when mflux reports epoch-relative counts")
    p.add_argument("--resume-checkpoint", default=None)
    return p.parse_args()


def build_command(config_path: str, resume: str | None) -> list:
    """Probe for mflux's training entrypoint. Prefer the module form (uses
    THIS interpreter, no PATH ambiguity); fall back to the console script."""
    module_probe = subprocess.run(
        [sys.executable, "-c", "import importlib.util as u; raise SystemExit(0 if u.find_spec('mflux.dreambooth') else 1)"],
        capture_output=True,
    )
    if module_probe.returncode == 0:
        cmd = [sys.executable, "-m", "mflux.dreambooth", "--train-config", config_path]
    else:
        console = Path(sys.executable).parent / "mflux-train"
        if not console.exists():
            print(
                "USER_ERROR:MODULE_NOT_FOUND:mflux training entrypoint not found "
                "(neither mflux.dreambooth module nor mflux-train script) — "
                "update mflux via scripts/setup-image-video.sh",
                file=sys.stderr, flush=True,
            )
            sys.exit(2)
        cmd = [str(console), "--train-config", config_path]
    if resume:
        cmd += ["--resume-checkpoint", resume]
    return cmd


# mflux progress lines vary by version — try, in order:
#   "... step 12/400 ... loss: 0.123"  /  "Step 12/400, loss=0.123"
#   "Epoch 3/100 ... loss 0.123"       (epoch-relative; scaled by --total-steps)
STEP_RES = [
    re.compile(r"[Ss]teps?[\s:=]+(\d+)\s*/\s*(\d+).*?[Ll]oss[\s:=]+([\d.eE+-]+)"),
    re.compile(r"(\d+)\s*/\s*(\d+).*?[Ll]oss[\s:=]+([\d.eE+-]+)"),
]
EPOCH_RE = re.compile(r"[Ee]poch[\s:=]+(\d+)\s*/\s*(\d+)")
NOISE_RE = re.compile(r"FutureWarning|UserWarning|DeprecationWarning", re.I)


class ArtifactWatcher(threading.Thread):
    """Poll the checkpoints dir for new checkpoint files + validation PNGs.
    PNGs copy into samples/ so the server's sample route can serve them."""

    def __init__(self, checkpoints_dir: Path, samples_dir: Path, get_step):
        super().__init__(daemon=True)
        self.checkpoints_dir = checkpoints_dir
        self.samples_dir = samples_dir
        self.get_step = get_step
        self.seen = set()
        self.stop_event = threading.Event()

    def scan(self):
        if not self.checkpoints_dir.exists():
            return
        for f in sorted(self.checkpoints_dir.rglob("*")):
            if not f.is_file() or f in self.seen:
                continue
            self.seen.add(f)
            step = self.get_step()
            if f.suffix in (".zip", ".safetensors") and "checkpoint" in f.name.lower() or f.suffix == ".zip":
                log(f"CHECKPOINT:{f}:{step}")
            elif f.suffix == ".png":
                dest = self.samples_dir / f"step-{step:06d}-{f.name}"
                try:
                    shutil.copyfile(f, dest)
                    log(f"SAMPLE:{dest}:{step}")
                except OSError as err:
                    log(f"STATUS:sample copy failed: {err}")

    def run(self):
        while not self.stop_event.wait(5.0):
            self.scan()
        self.scan()  # final sweep


def find_adapter(checkpoints_dir: Path, output_dir: Path) -> Path | None:
    """Newest adapter .safetensors — direct file first, else extract from
    the newest checkpoint zip."""
    direct = sorted(checkpoints_dir.rglob("*.safetensors"), key=lambda f: f.stat().st_mtime)
    if direct:
        return direct[-1]
    zips = sorted(checkpoints_dir.rglob("*.zip"), key=lambda f: f.stat().st_mtime)
    for z in reversed(zips):
        with zipfile.ZipFile(z) as zf:
            members = [m for m in zf.namelist() if m.endswith(".safetensors")]
            if not members:
                continue
            extract_dir = output_dir / "adapter"
            extract_dir.mkdir(parents=True, exist_ok=True)
            zf.extract(members[0], extract_dir)
            return extract_dir / members[0]
    return None


def main():
    global CHILD
    args = parse_args()
    output_dir = Path(args.output_dir)
    samples_dir = output_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)
    config = json.loads(Path(args.train_config).read_text())
    checkpoints_dir = Path(config.get("save", {}).get("output_path") or (output_dir / "checkpoints"))
    checkpoints_dir.mkdir(parents=True, exist_ok=True)

    total_steps = max(1, args.total_steps)
    state = {"step": 0, "loss": None}

    watcher = ArtifactWatcher(checkpoints_dir, samples_dir, lambda: state["step"])
    watcher.start()

    cmd = build_command(args.train_config, args.resume_checkpoint)
    log("STAGE:load-model")
    log(f"STATUS:launching {' '.join(Path(cmd[0]).name if i == 0 else c for i, c in enumerate(cmd))}")
    CHILD = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    if STOP_REQUESTED:  # SIGTERM raced the spawn
        CHILD.terminate()

    in_training = False
    for raw in CHILD.stdout:
        line = raw.rstrip("\n")
        if not line.strip() or NOISE_RE.search(line):
            continue

        matched = False
        for step_re in STEP_RES:
            m = step_re.search(line)
            if m:
                cur, total = int(m.group(1)), int(m.group(2))
                # mflux totals can be epoch-relative; trust them when they
                # look like our budget, else scale into --total-steps space.
                if total != total_steps and total > 0:
                    cur = round(cur / total * total_steps)
                    total = total_steps
                state["step"] = cur
                try:
                    state["loss"] = float(m.group(3))
                except ValueError:
                    pass
                if not in_training:
                    in_training = True
                    log("STAGE:training")
                log(f"STEP:{cur}:{total}:{state['loss'] if state['loss'] is not None else 'nan'}")
                matched = True
                break
        if matched:
            continue

        em = EPOCH_RE.search(line)
        if em:
            if not in_training:
                in_training = True
                log("STAGE:training")
            log(f"STATUS:epoch {em.group(1)}/{em.group(2)}")
            continue

        # Forward everything else (truncated) — keeps the JS idle watchdog
        # fed during model load/quantize phases and aids debugging.
        log(f"STATUS:{line[:300]}")

    code = CHILD.wait()
    watcher.stop_event.set()
    watcher.join(timeout=10)

    if STOP_REQUESTED:
        log("STATUS:canceled-checkpoint-saved" if state["step"] else "STATUS:canceled")
        sys.exit(143)

    if code != 0:
        print(f"❌ mflux trainer exited with code {code}", file=sys.stderr, flush=True)
        sys.exit(code or 1)

    adapter = find_adapter(checkpoints_dir, output_dir)
    if not adapter:
        print(
            "USER_ERROR:TRAINING_FAILED:mflux finished but no adapter .safetensors found under "
            f"{checkpoints_dir}", file=sys.stderr, flush=True,
        )
        sys.exit(1)
    log("RESULT:" + json.dumps({
        "adapter_path": str(adapter),
        "steps": state["step"] or total_steps,
        "final_loss": state["loss"],
    }))


if __name__ == "__main__":
    main()
