"""Public API used by the CLI (`python -m geocore run`)."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from geocore.analysis.executor import OP_HANDLERS, execute_analyze
from geocore.protocol import E_INPUT_MISSING, GeoCoreError
from geocore.runtime.artifact import ArtifactStore
from geocore.runtime.datasource import load_dataset


def inspect(payload: dict) -> dict:
    """Understand a dataset without analyzing it."""
    path = str(payload.get("path") or "")
    gdf, prov = load_dataset(path)

    types = {}
    for t in map(str, gdf.geometry.geom_type):
        types[t] = types.get(t, 0) + 1
    minx, miny, maxx, maxy = [float(v) for v in gdf.total_bounds]
    n_invalid = int((~gdf.geometry.is_valid).sum()) if len(gdf) else 0
    n_null = int(gdf.geometry.isna().sum())

    fields = []
    skip = {"geometry"}
    for col in gdf.columns:
        if col in skip:
            continue
        series = gdf[col]
        samples = [v.item() if hasattr(v, "item") else v
                   for v in pd.unique(series.dropna())[:3]]
        fields.append({
            "name": str(col),
            "dtype": str(series.dtype),
            "samples": samples,
        })

    crs = gdf.crs.to_string() if gdf.crs is not None else None
    coords_in_range = bool(-181 <= minx <= 181 and -91 <= miny <= 91 and -181 <= maxx <= 181 and -91 <= maxy <= 91)
    warnings = []
    if crs is None:
        warnings.append("数据缺失 CRS" + ("（坐标在经纬度范围内，分析时可安全假定 EPSG:4326）" if coords_in_range
                                        else "且坐标不在经纬度范围内，度量前必须先明确 CRS"))
    if n_invalid:
        warnings.append(f"{n_invalid} 个无效几何，分析时将自动修复")
    if n_null:
        warnings.append(f"{n_null} 条要素缺少几何")

    return {
        "kind": "vector",
        "source": prov,
        "geometry_types": types,
        "count": int(len(gdf)),
        "crs": crs,
        "extent_bbox": [minx, miny, maxx, maxy],
        "fields": fields,
        "quality": {
            "invalid_geometries": n_invalid,
            "null_geometries": n_null,
            "missing_crs": crs is None,
            "wgs84_assumable_if_missing": coords_in_range,
        },
        "capabilities": ["query_measure", "proximity", "overlay", "zonal"],
        "supported_formats_note": "Phase 1 为矢量核心；Field/Network/Spatial Statistics 属于后续阶段",
        "notes": warnings,
    }


def analyze(workdir: Path, payload: dict) -> dict:
    return execute_analyze(Path(workdir), payload)


def visualize(workdir: Path, payload: dict) -> dict:
    from geocore.analysis.resolver import DatasetResolver
    from geocore.runtime.artifact import is_artifact_token
    from geocore.viz.map import render_map

    source = str(payload.get("source") or "")
    style = dict(payload.get("style") or {})
    title = str(payload.get("title") or style.get("title") or "GeoCore 地图")

    store = ArtifactStore(Path(workdir))

    base_artifact = source if is_artifact_token(source) else None
    if base_artifact:
        # 校验存在性并让地图写入既有分析产物目录
        store.get(base_artifact)
        artifact_id = base_artifact
    else:
        artifact_id, _ = store.create("map", title)

    resolver = DatasetResolver(store)
    gdf, _ = resolver.frame(source)

    out_path = store.image_path_for(artifact_id, title)
    legend = render_map(gdf, style=style, out_path=out_path, title=title)

    if not base_artifact:
        store.finalize_map(artifact_id, image=str(out_path), legend=legend,
                           source=source, warnings=list(dict.fromkeys(resolver.warnings)),
                           crs=resolver.crs_info())
    else:
        meta = store.get(artifact_id)
        meta.setdefault("images", [])
        if not any(img.get("path") == str(out_path) for img in meta["images"]):
            meta["images"].append({"path": str(out_path)})
        store.overwrite_meta(artifact_id, meta)
    return {
        "artifact_id": artifact_id,
        "image_path": str(out_path),
        "legend": legend,
        "warnings": list(dict.fromkeys(resolver.warnings)),
    }


def show(workdir: Path, artifact_id: str) -> dict:
    store = ArtifactStore(Path(workdir))
    meta = store.get(str(artifact_id))
    listed = store.list_ids()
    if meta["artifact_id"] not in listed:
        raise GeoCoreError(E_INPUT_MISSING, "Artifact 索引异常", {"id": artifact_id})
    return meta


def list_operations() -> dict:
    """供 Agent 自省当前可用的操作词表。"""
    return {"operations": sorted(OP_HANDLERS)}
