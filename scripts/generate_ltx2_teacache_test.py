#!/usr/bin/env python3
"""Unit tests for generate_ltx2 TeaCache monkey patches."""
from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path


HELPER_PATH = Path(__file__).with_name("generate_ltx2.py")


class GenerateLtx2TeaCacheTest(unittest.TestCase):
    def setUp(self):
        self.module_name = "generate_ltx2_under_test"
        self.original_modules = {
            name: sys.modules.get(name)
            for name in [
                self.module_name,
                "ltx_pipelines_mlx",
                "ltx_pipelines_mlx.retake",
                "ltx_pipelines_mlx.a2vid_two_stage",
                "ltx_pipelines_mlx.ti2vid_two_stages",
            ]
        }
        for name in self.original_modules:
            sys.modules.pop(name, None)

        root = types.ModuleType("ltx_pipelines_mlx")
        root.__path__ = []
        retake = types.ModuleType("ltx_pipelines_mlx.retake")
        a2v = types.ModuleType("ltx_pipelines_mlx.a2vid_two_stage")
        two_stages = types.ModuleType("ltx_pipelines_mlx.ti2vid_two_stages")
        self.calls = []

        def retake_loop(*args, teacache=None, **kwargs):
            return {"caller": "retake", "teacache": teacache, "kwargs": kwargs}

        def a2v_loop(*args, teacache=None, **kwargs):
            return {"caller": "a2v", "teacache": teacache, "kwargs": kwargs}

        def build_teacache(num_steps, thresh):
            self.calls.append((num_steps, thresh))
            return {"num_steps": num_steps, "thresh": thresh}

        retake.guided_denoise_loop = retake_loop
        a2v.guided_denoise_loop = a2v_loop
        two_stages._build_teacache_controller = build_teacache

        sys.modules["ltx_pipelines_mlx"] = root
        sys.modules["ltx_pipelines_mlx.retake"] = retake
        sys.modules["ltx_pipelines_mlx.a2vid_two_stage"] = a2v
        sys.modules["ltx_pipelines_mlx.ti2vid_two_stages"] = two_stages
        self.retake = retake
        self.a2v = a2v

        spec = importlib.util.spec_from_file_location(self.module_name, HELPER_PATH)
        self.helper = importlib.util.module_from_spec(spec)
        sys.modules[self.module_name] = self.helper
        spec.loader.exec_module(self.helper)

    def tearDown(self):
        for name, module in self.original_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def test_extend_patch_builds_stage1_teacache_from_sigmas(self):
        self.helper._EXTEND_TC_CONFIG = self.helper._teacache_config(True, True, 30)

        result = self.retake.guided_denoise_loop(sigmas=[1.0, 0.5, 0.0])

        self.assertEqual(result["teacache"], {"num_steps": 2, "thresh": None})
        self.assertEqual(self.calls, [(2, None)])

    def test_a2v_patch_uses_configured_step_count_without_sigmas(self):
        self.helper._A2V_TC_CONFIG = self.helper._teacache_config(True, True, 17)

        result = self.a2v.guided_denoise_loop()

        self.assertEqual(result["teacache"], {"num_steps": 17, "thresh": None})
        self.assertEqual(self.calls, [(17, None)])

    def test_patch_respects_disabled_config(self):
        self.helper._EXTEND_TC_CONFIG = self.helper._teacache_config(False, True, 30)

        result = self.retake.guided_denoise_loop(sigmas=[1.0, 0.0])

        self.assertIsNone(result["teacache"])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
