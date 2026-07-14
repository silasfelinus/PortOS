#!/usr/bin/env python3
"""
challenge_submit.py — bridge between the PortOS CLI agent and the Challenge
Center (silasfelinus/kind_robots' /api/challenges surface).

Mirrors silasfelinus/conductor's scripts/challenge_submit.py interface
(fetch challenge -> collect agent output -> POST submission -> print
leaderboard standing), but drives the agent invocation itself instead of
relying on an external pipe: PortOS has no single "the agent" the way
conductor does, so this script resolves whichever CLI provider the user has
configured (data/providers.json + data/settings.json's `challengeSubmit`
slot, same convention as the autofixer — see autofixer/server.js) and runs
it via scripts/lib/run_cli_provider.mjs.

Default one-shot flow:

    python scripts/challenge_submit.py <challenge-slug>

  1. GET /api/challenges/<slug> for the challenge's promptText
  2. Pass promptText to the configured PortOS CLI provider
  3. Collect the agent's final output
  4. POST /api/challenges/<slug>/submissions as contender "portos-agent"
  5. Print the created submission id and leaderboard standing

--prompt-only fetches and prints the prompt without running an agent or
submitting (mirrors conductor's fetch-only default). --output FILE|- skips
the agent invocation and submits pre-collected output instead (mirrors
conductor's --output flow exactly, for callers that already ran the agent
themselves).

Env:
  KR_API_TOKEN   required to submit (Bearer token: Server.apiKey or admin JWT)
  KR_BASE_URL    default https://kind-robots.vercel.app

Usage:
  python scripts/challenge_submit.py <challenge-slug> [--contender portos-agent]
      [--variant-key default] [--provider-id ID] [--model MODEL]
      [--timeout-ms 300000] [--prompt-only] [--output FILE|-]
      [--prompt-used TEXT] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

KR_BASE_URL = os.environ.get("KR_BASE_URL", "https://kind-robots.vercel.app").rstrip("/")
KR_API_TOKEN = os.environ.get("KR_API_TOKEN", "").strip()

DEFAULT_CONTENDER = "portos-agent"
DEFAULT_VARIANT_KEY = "default"

ROOT = Path(__file__).resolve().parents[1]
RUN_CLI_PROVIDER = ROOT / "scripts" / "lib" / "run_cli_provider.mjs"


class ChallengeSubmitError(Exception):
    pass


def http_json(method: str, url: str, token: str = "", body: dict | None = None, timeout: int = 30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "null")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode() or "null")
        except (ValueError, OSError):
            payload = None
        return e.code, payload
    except urllib.error.URLError as e:
        raise ChallengeSubmitError(f"could not reach {url}: {e.reason}") from e


def fetch_challenge(base_url: str, slug: str) -> dict:
    status, body = http_json("GET", f"{base_url}/api/challenges/{slug}")
    if status == 404:
        raise ChallengeSubmitError(f"challenge {slug!r} not found")
    if status != 200 or not body or not body.get("success"):
        message = (body or {}).get("message", f"HTTP {status}")
        raise ChallengeSubmitError(f"failed to fetch challenge {slug!r}: {message}")
    return body["data"]


def run_agent(prompt: str, provider_id: str | None, model: str | None, timeout_ms: int) -> str:
    """Runs scripts/lib/run_cli_provider.mjs, which resolves the user's configured
    CLI provider from data/providers.json + data/settings.json and spawns it with
    `prompt` on stdin. Raises ChallengeSubmitError on any failure."""
    cmd = ["node", str(RUN_CLI_PROVIDER), "--settings-key", "challengeSubmit", "--timeout-ms", str(timeout_ms)]
    if provider_id:
        cmd += ["--provider-id", provider_id]
    if model:
        cmd += ["--model", model]

    result = subprocess.run(
        cmd,
        input=prompt,
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        timeout=(timeout_ms / 1000) + 30,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or f"run_cli_provider.mjs exited with code {result.returncode}"
        raise ChallengeSubmitError(f"agent invocation failed: {message}")

    output_text = result.stdout.strip()
    if not output_text:
        raise ChallengeSubmitError("agent invocation produced no output")
    return output_text


def submit_challenge(
    base_url: str,
    token: str,
    slug: str,
    contender_slug: str,
    variant_key: str,
    output_text: str,
    prompt_used: str | None = None,
) -> dict:
    if not token:
        raise ChallengeSubmitError("KR_API_TOKEN is required to submit a challenge entry")

    payload = {
        "contenderSlug": contender_slug,
        "variantKey": variant_key,
        "outputText": output_text,
    }
    if prompt_used:
        payload["promptUsed"] = prompt_used

    status, body = http_json(
        "POST", f"{base_url}/api/challenges/{slug}/submissions", token=token, body=payload
    )
    if status == 409:
        message = (body or {}).get("message", "duplicate submission")
        raise ChallengeSubmitError(f"submission rejected: {message}")
    if status != 201 or not body or not body.get("success"):
        message = (body or {}).get("message", f"HTTP {status}")
        raise ChallengeSubmitError(f"failed to submit to challenge {slug!r}: {message}")
    return body["data"]


def fetch_leaderboard(base_url: str, slug: str) -> list[dict]:
    status, body = http_json("GET", f"{base_url}/api/challenges/{slug}/leaderboard")
    if status != 200 or not body or not body.get("success"):
        message = (body or {}).get("message", f"HTTP {status}")
        raise ChallengeSubmitError(f"failed to fetch leaderboard for {slug!r}: {message}")
    return body["data"]["leaderboard"]


def find_standing(leaderboard: list[dict], contender_slug: str) -> tuple[int, dict] | None:
    for rank, entry in enumerate(leaderboard, start=1):
        if entry.get("slug") == contender_slug:
            return rank, entry
    return None


def read_output(path: str) -> str:
    if path == "-":
        text = sys.stdin.read()
    else:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    text = text.strip()
    if not text:
        raise ChallengeSubmitError(f"no output text read from {path!r}")
    return text


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("slug", help="challenge slug")
    parser.add_argument("--contender", default=DEFAULT_CONTENDER, help=f"contender slug (default: {DEFAULT_CONTENDER})")
    parser.add_argument("--variant-key", default=DEFAULT_VARIANT_KEY, help=f"variant key (default: {DEFAULT_VARIANT_KEY})")
    parser.add_argument("--provider-id", help="override the configured CLI provider id for this run")
    parser.add_argument("--model", help="override the configured CLI provider's model for this run")
    parser.add_argument("--timeout-ms", type=int, default=300000, help="agent invocation timeout in ms (default: 300000)")
    parser.add_argument("--prompt-only", action="store_true", help="only fetch and print the challenge prompt; don't run the agent or submit")
    parser.add_argument("--output", metavar="FILE", help="skip running the agent; submit this file's contents instead ('-' for stdin)")
    parser.add_argument("--prompt-used", metavar="TEXT", help="override promptUsed sent with the submission (defaults to the challenge's promptText)")
    parser.add_argument("--kr-base-url", default=KR_BASE_URL, help="override KR_BASE_URL")
    parser.add_argument("--dry-run", action="store_true", help="do everything except the POST; print what would be submitted")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    base_url = args.kr_base_url.rstrip("/")

    try:
        challenge = fetch_challenge(base_url, args.slug)
        prompt_text = challenge["promptText"]

        if args.prompt_only:
            print(f"# {challenge.get('title', args.slug)} ({challenge.get('challengeType', 'UNKNOWN')})", file=sys.stderr)
            print(prompt_text)
            return 0

        if args.output is not None:
            output_text = read_output(args.output)
        else:
            print(f"# Running {args.slug!r} through the configured CLI provider...", file=sys.stderr)
            output_text = run_agent(prompt_text, args.provider_id, args.model, args.timeout_ms)

        prompt_used = args.prompt_used or prompt_text

        if args.dry_run:
            print(
                f"DRY RUN: would submit {len(output_text)} chars as {args.contender} "
                f"(variant={args.variant_key!r}) to {args.slug!r}",
                file=sys.stderr,
            )
            return 0

        submission = submit_challenge(
            base_url,
            KR_API_TOKEN,
            args.slug,
            args.contender,
            args.variant_key,
            output_text,
            prompt_used=prompt_used,
        )
        print(f"Submission #{submission['id']} created for {args.contender} on {args.slug!r} (variant {args.variant_key!r}).")

        leaderboard = fetch_leaderboard(base_url, args.slug)
        standing = find_standing(leaderboard, args.contender)
        if standing is None:
            print("Leaderboard standing: not yet ranked.")
        else:
            rank, entry = standing
            score = entry.get("score", {})
            print(
                f"Leaderboard standing: #{rank} of {len(leaderboard)} "
                f"— net score {score.get('netScore', 0)} ({score.get('votes', 0)} votes)."
            )
        return 0
    except ChallengeSubmitError as error:
        print(f"❌ {error}", file=sys.stderr)
        return 1
    except subprocess.TimeoutExpired:
        print("❌ agent invocation timed out", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
