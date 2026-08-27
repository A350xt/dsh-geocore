"""Plan executor: runs the ordered operation list and persists one artifact."""

from __future__ import annotations

import re

from geocore.analysis import overlay, proximity, query, zonal
from geocore.analysis.resolver import DatasetResolver
from geocore.protocol import E_BAD_REQUEST, E_EMPTY_RESULT, E_OP_UNKNOWN, GeoCoreError
from geocore.runtime.artifact import ArtifactStore

_STEP_ID_RE = re.compile(r"\A[A-Za-z0-9_]{1,32}\Z")

OP_HANDLERS: dict[str, object] = {}
for _mod in (query, proximity, overlay, zonal):
    OP_HANDLERS.update(_mod.SPEC)


def execute_analyze(workdir, request: dict) -> dict:
    operations = request.get("operations")
    if not isinstance(operations, list) or not operations:
        raise GeoCoreError(E_BAD_REQUEST, "analyze 需要 operations 列表（至少一步）")

    title = str(request.get("title") or "空间分析")
    output_format = str((request.get("output") or {}).get("format", "gpkg")).lower()

    store = ArtifactStore(workdir)
    artifact_id, _dir = store.create("analysis", title)
    resolver = DatasetResolver(store)

    steps: list[dict] = []
    summaries: list[str] = []
    seen_ids: set[str] = set()
    final_gdf = None
    intermediates: dict[str, object] = {}

    for i, op_req in enumerate(operations):
        if not isinstance(op_req, dict):
            raise GeoCoreError(E_BAD_REQUEST, f"第 {i + 1} 步不是对象")
        op = op_req.get("op")
        if not op:
            raise GeoCoreError(E_BAD_REQUEST, f"第 {i + 1} 步缺少 op 字段")
        handler = OP_HANDLERS.get(op)
        if handler is None:
            raise GeoCoreError(
                E_OP_UNKNOWN,
                f"未知操作：{op}",
                {"step": i + 1, "available": sorted(OP_HANDLERS)},
            )
        raw_id = str(op_req.get("id") or f"s{i + 1}")
        if not _STEP_ID_RE.fullmatch(raw_id) or raw_id in seen_ids:
            raise GeoCoreError(E_BAD_REQUEST, f"步骤 id 非法或重复：{raw_id}", {"step": i + 1})
        seen_ids.add(raw_id)

        params = {k: v for k, v in op_req.items() if k not in ("op", "id", "allow_empty")}
        allow_empty = bool(op_req.get("allow_empty", False))
        try:
            result = handler(resolver, params, raw_id)
        except GeoCoreError as exc:
            exc.details = {**exc.details, "step": raw_id, "op": op}
            raise
        except KeyError as exc:
            raise GeoCoreError(E_BAD_REQUEST, str(exc.args[0]), {"step": raw_id, "op": op}) from exc

        gdf = result.gdf
        if gdf is None or len(gdf) == 0:
            if not allow_empty:
                raise GeoCoreError(
                    E_EMPTY_RESULT,
                    f"步骤 {raw_id}（{op}）结果为空；如空集属预期，请在该步加 \"allow_empty\": true",
                    {"step": raw_id, "op": op},
                )
            result.summaries.append(f"（步骤 {raw_id} 结果为空——已按 allow_empty 继续）")

        resolver.register_step(raw_id, gdf)
        intermediates[raw_id] = gdf
        first_summary = result.summaries[0] if result.summaries else ""
        steps.append({
            "id": raw_id,
            "op": op,
            "count": int(len(gdf)),
            "summary": first_summary,
        })
        summaries.extend(result.summaries)
        final_gdf = gdf

    meta = store.finalize_analysis(
        artifact_id,
        title=title,
        operations=operations,
        steps=steps,
        summaries=summaries,
        warnings=list(dict.fromkeys(resolver.warnings)),
        crs_info=resolver.crs_info(),
        inputs=resolver.inputs_meta,
        result_gdf=final_gdf,
        result_format=output_format,
        intermediates=intermediates,
    )
    return {
        "artifact_id": artifact_id,
        "title": title,
        "result": meta["result"],
        "summary": summaries,
        "steps": steps,
        "warnings": meta["warnings"],
        "crs": meta["crs"],
        "inputs": resolver.inputs_meta,
        "intermediate_layers": meta.get("intermediate_layers", {}),
    }
