"""geocore CLI: one JSON request on stdin → one JSON envelope on stdout.

Usage:
    echo '{"action":"inspect","path":"..."}' | python -m geocore run --workdir D:/tmp/gis

Actions: inspect | analyze | visualize | show | operations | read | list
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="geocore")
    parser.add_argument("command", choices=["run"], help="run 一条 JSON 请求")
    parser.add_argument("--workdir", default=os.environ.get("GEOCORE_WORKDIR"))
    args = parser.parse_args(argv)

    try:
        # 中文 Windows 默认按本地代码页（GBK）收发：桥协议统一强制 UTF-8。
        # stdin 不重配会出现中文参数被按 GBK 解码 → 乱码/surrogates。
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass

    from geocore.protocol import (
        envelope_from_exception,
        error_envelope,
        json_default,
        ok_envelope,
    )

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        print(json.dumps(error_envelope("E_BAD_REQUEST", f"请求不是合法 JSON：{exc}"),
                         ensure_ascii=False, default=json_default))
        return 2

    action = str(payload.pop("action", ""))
    workdir = Path(payload.pop("workdir", None) or args.workdir or ".")

    from geocore import api

    try:
        if action == "inspect":
            result = api.inspect(payload)
        elif action == "analyze":
            result = api.analyze(workdir, payload)
        elif action == "visualize":
            result = api.visualize(workdir, payload)
        elif action == "show":
            result = api.show(workdir, payload.get("artifact_id"))
        elif action == "operations":
            result = api.list_operations()
        elif action == "read":
            result = api.read_layer(workdir, payload)
        elif action == "list":
            result = api.list_inventory(workdir, payload)
        else:
            from geocore.protocol import error_envelope

            print(json.dumps(
                error_envelope("E_BAD_REQUEST",
                               f"未知 action:{action}（可用 inspect/analyze/visualize/show/operations）"),
                ensure_ascii=False, default=json_default))
            return 2
        print(json.dumps(ok_envelope(result), ensure_ascii=False, default=json_default))
        return 0
    except Exception as exc:  # 统一出口：桥协议永远收到封套
        env = envelope_from_exception(exc)
        if env["error"]["code"] == "E_INTERNAL":
            env["error"]["details"]["traceback"] = traceback.format_exc(limit=6)
        print(json.dumps(env, ensure_ascii=False, default=json_default))
        return 2 if env["error"]["code"] != "E_INTERNAL" else 1
