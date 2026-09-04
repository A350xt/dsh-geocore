"""Public API used by the CLI (`python -m geocore run`)."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from geocore.analysis.executor import OP_HANDLERS, execute_analyze
from geocore.protocol import (
    E_BAD_REQUEST,
    E_INPUT_MISSING,
    E_OUTPUT_ERROR,
    GeoCoreError,
    json_safe,
)
from geocore.runtime.artifact import ArtifactStore
from geocore.runtime.datasource import load_dataset
from geocore.runtime.prepare import assume_missing_crs


def inspect(payload: dict) -> dict:
    """Understand a dataset without analyzing it."""
    path = str(payload.get("path") or "")
    if Path(path).suffix.lower() in (".tif", ".tiff"):
        from geocore.raster_core import raster_meta_of

        meta = raster_meta_of(path)
        return {
            **meta,
            "source": {"format": "tif", "path": path},
            "capabilities": ["raster.*"],
            "supported_formats_note": "栅格已支持（raster 域算子）；多波段先指定 band",
            "notes": [
                f"NoData 占比 {meta['nodata_pct']}%",
                "栅格化/重采样/统计请走 gis_analyze 的 raster.* 词表",
            ],
        }
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
        samples = [json_safe(v) for v in pd.unique(series.dropna())[:3]]
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
    from geocore.raster_core import is_raster_path
    from geocore.runtime.artifact import is_artifact_token
    from geocore.viz.map import render_map

    source = str(payload.get("source") or "")
    style = dict(payload.get("style") or {})
    title = str(payload.get("title") or style.get("title") or "GeoCore 地图")
    base = payload.get("base")
    base_style = dict(payload.get("base_style") or {}) if base else None

    store = ArtifactStore(Path(workdir))

    base_artifact = source if is_artifact_token(source) else None
    if base_artifact:
        # 校验存在性并让地图写入既有分析产物目录
        store.get(base_artifact)
        artifact_id = base_artifact
    else:
        artifact_id, _ = store.create("map", title)

    # 制图保持源 CRS（避免坐标轴出现米制刻度）；多层仍自动对齐到首个输入
    resolver = DatasetResolver(store, crs_override="source")
    base_gdf = None
    if base:
        base_gdf, _ = resolver.frame(str(base))

    out_path = store.image_path_for(artifact_id, title)

    def _is_raster_source(tok: str) -> bool:
        from geocore.analysis.resolver import parse_step_ref

        if is_raster_path(tok):
            return True
        if is_artifact_token(tok):
            meta = store.get(tok)
            return str((meta.get("result") or {}).get("format", "")).lower() in ("tif", "tiff")
        step_ref = parse_step_ref(tok)
        if step_ref:
            meta = store.get(step_ref[0])
            info = (meta.get("intermediate_layers") or {}).get(step_ref[1]) or {}
            return str(info.get("kind", "")) == "raster" or \
                str(info.get("layer", "")).lower().endswith(".tif")
        return False

    if _is_raster_source(source):
        # 栅格制图：连续色带拉伸 / 分类色表
        from geocore.viz.map import render_raster

        rf, _ = resolver.raster(source)
        legend = render_raster(rf, style=style, out_path=out_path, title=title)
    else:
        gdf, _ = resolver.frame(source)
        legend = render_map(gdf, style=style, out_path=out_path, title=title,
                            base_gdf=base_gdf, base_style=base_style)

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


# --------------------------------------------------------------- Studio 支持


def read_layer(workdir: Path, payload: dict) -> dict:
    """把数据集 / artifact 最终结果 / artifact 中间步骤导出为 WGS84 GeoJSON。

    供地图前端渲染：任何来源统一重投影到 EPSG:4326，超大图层按 max_features 截断。
    """
    from geocore.analysis.resolver import parse_step_ref
    from geocore.runtime.artifact import is_artifact_token

    source = str(payload.get("source") or "")
    max_features = int(payload.get("max_features") or 5000)
    max_features = max(1, min(max_features, 50_000))
    wanted_fields = payload.get("fields")
    if wanted_fields is not None and not isinstance(wanted_fields, list):
        raise GeoCoreError(E_BAD_REQUEST, "fields 必须是字段名数组")

    layer = None
    artifact_id = None
    if is_artifact_token(source):
        artifact_id = source
        store = ArtifactStore(Path(workdir))
        meta = store.get(artifact_id)  # 存在性校验
        if str((meta.get("result") or {}).get("format", "")).lower() in ("tif", "tiff"):
            raise GeoCoreError(
                E_BAD_REQUEST,
                "这是栅格产物，Studio 地图暂不支持栅格上图；请在 DSH 里用 gis_visualize 制图，"
                "或先 raster.polygonize 转矢量",
                {"artifact": artifact_id},
            )
        path = store.resolve_result_path(artifact_id)
    elif (step_ref := parse_step_ref(source)):
        artifact_id, step_id = step_ref
        store = ArtifactStore(Path(workdir))
        meta = store.get(artifact_id)
        steps_index = meta.get("intermediate_layers") or {}
        if step_id not in steps_index:
            raise GeoCoreError(
                E_INPUT_MISSING,
                f"artifact {artifact_id} 没有中间步骤 {step_id}",
                {"available_steps": sorted(steps_index)},
            )
        path = store.resolve_result_path(artifact_id)
        layer = steps_index[step_id]["layer"]
    else:
        path = Path(source)
        if not path.is_absolute() or not path.exists():
            raise GeoCoreError(E_INPUT_MISSING, f"输入不存在：{source}", {"source": source})

    gdf, _prov = load_dataset(str(path), layer=layer)

    src_crs = gdf.crs.to_string() if gdf.crs is not None else None
    warnings: list[str] = []
    if gdf.crs is None:
        gdf = assume_missing_crs(gdf, str(path.name), warnings)
        src_crs = gdf.crs.to_string()

    total = int(len(gdf))
    truncated = False
    if total > max_features:
        gdf = gdf.head(max_features)
        truncated = True
        warnings.append(f"图层过大：仅返回前 {max_features} / {total} 个要素")

    if wanted_fields:
        missing = [f for f in wanted_fields if f not in gdf.columns]
        if missing:
            raise GeoCoreError(E_INPUT_MISSING, f"字段不存在：{missing}",
                               {"available": list(map(str, gdf.columns))})
        gdf = gdf[list(wanted_fields) + [gdf.geometry.name]]

    if gdf.crs is not None and gdf.crs.is_projected:
        gdf = gdf.to_crs("EPSG:4326")

    # datetime 列转 ISO 字符串：to_json 不处理 datetime64，会整包失败
    for col in gdf.columns:
        if pd.api.types.is_datetime64_any_dtype(gdf[col]):
            gdf[col] = gdf[col].astype(str).replace({"NaT": None, "nan": None})

    try:
        geojson = json.loads(gdf.to_json(drop_id=True))
    except Exception as exc:
        raise GeoCoreError(E_OUTPUT_ERROR, f"GeoJSON 序列化失败：{exc}") from exc

    return {
        "source": source,
        "artifact": artifact_id,
        "layer": layer,
        "geojson": geojson,
        "meta": {
            "count_total": total,
            "count_returned": int(len(gdf)),
            "truncated": truncated,
            "crs_source": src_crs,
            "crs_display": "EPSG:4326",
            "geometry_types": sorted({str(t) for t in gdf.geometry.geom_type}),
            "fields": [str(c) for c in gdf.columns if c != gdf.geometry.name],
        },
        "warnings": warnings,
    }


def list_inventory(workdir: Path, payload: dict) -> dict:
    """数据集 + artifacts 清单（Studio 图层面板数据源）。

    数据集来源优先级（对齐「Studio 只见当前 agent 项目」的原则）：
    1. agent-used：artifact 元数据里记录的 inputs（agent 实际用过的文件）；
    2. workspace：请求给定的 datasets_dirs（DSH 工作区根）做有上限的浅扫描；
    3. 兼容旧 datasets_dir 单目录参数。
    坏 meta 跳过并计数，绝不让整个清单失败。
    """
    roots: list[str] = []
    for key in ("datasets_dirs", "datasets_dir"):
        v = payload.get(key)
        if isinstance(v, str) and v:
            roots.append(v)
        elif isinstance(v, list):
            roots.extend(str(x) for x in v if str(x))
    out: dict = {"datasets": [], "artifacts": [], "skipped_corrupt": 0}
    seen_paths: set[str] = set()

    def _push_dataset(path_str: str, origin: str) -> None:
        p = Path(path_str)
        key = str(p).replace("\\", "/").lower()
        if key in seen_paths or not p.is_file():
            return
        ext = p.suffix.lower()
        if ext == ".json" and not _looks_like_geojson(p):
            return  # package.json/tsconfig.json 等非空间 JSON 不进清单
        fmt = next((k for k, exts in
                    {"geojson": (".geojson", ".json"), "gpkg": (".gpkg",),
                     "shapefile": (".shp",), "csv": (".csv",)}.items()
                    if ext in exts), None)
        if fmt is None:
            return
        seen_paths.add(key)
        out["datasets"].append({
            "name": p.stem,
            "path": str(p),
            "format": fmt,
            "size_bytes": p.stat().st_size,
            "origin": origin,
        })

    store = ArtifactStore(Path(workdir))
    workdir_real = str(store.root_real)
    metas: list[dict] = []
    for artifact_id in store.list_ids():
        try:
            meta = store.get(artifact_id)
        except GeoCoreError:
            out["skipped_corrupt"] += 1
            continue
        metas.append(meta)
        # agent 用过的输入文件 → 数据集清单（agent 自主决定显示什么的第一来源）
        for inp in meta.get("inputs") or []:
            p = inp.get("path")
            if p and not str(p).replace("\\", "/").lower().startswith(
                    workdir_real.replace("\\", "/").lower()):
                _push_dataset(str(p), "agent-used")

    for root_str in roots:
        root = Path(root_str)
        if not root.is_absolute() or not root.is_dir():
            continue
        _scan_workspace(root, _push_dataset, limit=300)

    out["datasets"].sort(key=lambda d: ({"agent-used": 0, "workspace": 1}.get(d["origin"], 2), d["name"]))

    for meta in metas:
        res = meta.get("result") or {}
        out["artifacts"].append({
            "artifact_id": meta["artifact_id"],
            "kind": meta.get("kind"),
            "title": meta.get("title", ""),
            "created": meta.get("created", ""),
            "count": res.get("count", 0),
            "geometry_types": res.get("geometry_types", []),
            "summary": (meta.get("summary") or [])[:6],
            "warnings": len(meta.get("warnings") or []),
            "steps": meta.get("steps") or [],
            "intermediate_layers": meta.get("intermediate_layers") or {},
        })
    out["artifacts"].reverse()  # 新的在前
    return out


_SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", "dist",
              "web-dist", "lib", "build", ".mimosa", ".zcode", ".pytest_cache",
              "tmp-visual", ".tmp-cli", "edge-profile"}


def _looks_like_geojson(path: Path) -> bool:
    """只读前 4KB 嗅探：含 FeatureCollection/Feature/features/geometries 才算空间 JSON。"""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            head = fh.read(4096).lower()
        return any(token in head for token in
                   ('"featurecollection"', '"features"', '"geometries"', '"type": "feature"'))
    except OSError:
        return False


def _scan_workspace(root: Path, push, *, limit: int, max_depth: int = 3) -> None:
    """有上限的浅扫描：深度 ≤3、跳过依赖/缓存目录、最多 limit 个文件。"""
    found = 0
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack and found < limit:
        cur, depth = stack.pop()
        try:
            entries = sorted(cur.iterdir())
        except OSError:
            continue
        for entry in entries:
            if found >= limit:
                break
            if entry.is_file():
                if entry.suffix.lower() in (".geojson", ".json", ".gpkg", ".shp", ".csv"):
                    push(str(entry), "workspace")
                    found += 1
            elif depth + 1 <= max_depth and entry.name not in _SKIP_DIRS \
                    and not entry.name.startswith("edge-profile"):
                stack.append((entry, depth + 1))
