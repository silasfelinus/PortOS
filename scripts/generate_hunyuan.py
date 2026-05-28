#!/usr/bin/env python3
"""
PortOS HunyuanVideo MLX helper.

Subprocesses upstream gaurav-nelson/HunyuanVideo_MLX inference entry point
from the cloned repo at --repo-dir. Same subprocess-not-import strategy as
generate_wan22.py — upstream isn't a pip package.

Spawned by server/services/videoGen/local.js when model.runtime === 'hunyuan'.

EXPERIMENTAL: upstream HunyuanVideo_MLX is community-maintained and its CLI
hasn't been pinned across releases. ~60 GB resident at bf16 → impractical
without first evicting Ollama / Whisper / Kokoro (see the Memory Management
panel under Settings → Local LLMs). If a future upstream commit reshapes
sample_video.py args, set `broken: true` on `hunyuan_video` in
data/media-models.json and grep here to update the translation.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PortOS HunyuanVideo MLX helper")
    p.add_argument("--repo-dir", required=True, help="Cloned HunyuanVideo_MLX repo root")
    p.add_argument("--model-repo", required=True, help="HF repo of HunyuanVideo weights (tencent/HunyuanVideo)")
    p.add_argument("--prompt", required=True)
    p.add_argument("--width", type=int, required=True)
    p.add_argument("--height", type=int, required=True)
    p.add_argument("--num-frames", type=int, default=129)
    p.add_argument("--steps", type=int, default=30)
    p.add_argument("--guidance", type=float, default=6.0)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--output", required=True)
    return p.parse_args()


def main() -> int:
    args = parse_args()

    repo_dir = Path(args.repo_dir).expanduser().resolve()
    if not repo_dir.is_dir():
        print(f"❌ HunyuanVideo MLX repo not found at {repo_dir}", file=sys.stderr)
        return 64
    # Upstream's entry point is sample_video.py (mirrors the original tencent
    # script name). Fall back to generate.py if upstream restructures.
    sample_py = repo_dir / "sample_video.py"
    if not sample_py.exists():
        sample_py = repo_dir / "generate.py"
    if not sample_py.exists():
        print(f"❌ no sample_video.py or generate.py under {repo_dir} — upstream layout changed?", file=sys.stderr)
        return 64

    print(f"STAGE:download-weights:{args.model_repo}", file=sys.stderr, flush=True)
    try:
        from huggingface_hub import snapshot_download
    except Exception as err:
        print(f"❌ huggingface_hub import failed: {err}", file=sys.stderr)
        return 64
    ckpt_dir = snapshot_download(args.model_repo)
    print(f"🔧 hunyuan: weights ← {ckpt_dir}", file=sys.stderr)

    upstream_args = [
        sys.executable,
        str(sample_py),
        "--model-base", ckpt_dir,
        "--video-size", str(args.height), str(args.width),
        "--video-length", str(args.num_frames),
        "--infer-steps", str(args.steps),
        "--guidance-scale", str(args.guidance),
        "--prompt", args.prompt,
        "--seed", str(args.seed),
        "--save-path", args.output,
    ]

    print(f"STAGE:inference", file=sys.stderr, flush=True)
    print(f"🎬 hunyuan generate {args.width}x{args.height} frames={args.num_frames} steps={args.steps}", file=sys.stderr)

    proc = subprocess.run(
        upstream_args,
        cwd=str(repo_dir),
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )

    if proc.returncode != 0:
        print(f"❌ hunyuan upstream exited {proc.returncode}", file=sys.stderr)
        return proc.returncode

    if not Path(args.output).exists():
        print(f"❌ hunyuan finished but {args.output} missing", file=sys.stderr)
        return 1

    print(f"✅ hunyuan saved {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
