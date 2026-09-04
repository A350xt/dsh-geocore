"""Per-request dataset resolver.

One analysis request = ONE analysis CRS, decided deterministically from the
first dataset that enters the pipeline (projected CRS wins; geographic inputs
are moved to a suitable UTM zone). Every subsequently loaded frame is repaired,
then reprojected into that CRS with a warning — so all downstream ops see a
consistent frame and cross-layer mismatches become impossible.

CRS 策略（v2）：
- 度量类操作（proximity/overlay/zonal/measure）必须投影坐标系 —— 默认仍走 UTM；
- 纯属性/拓扑类管线（filter/select/trajectory）默认 **保持源 CRS**，不再悄悄
  重投影（米制刻度的坐标轴不再是副作用）；
- 请求级 `crs` 参数可显式指定分析坐标系（"source" = 跟随首个输入，或
  "EPSG:xxxx" 等任意 CRS 串），优先级最高。
"""

from __future__ import annotations

import re
from pathlib import Path

import geopandas as gpd

from geocore.protocol import E_BAD_REQUEST, E_INPUT_MISSING, GeoCoreError
from geocore.runtime.artifact import is_artifact_token
from geocore.runtime.datasource import load_dataset
from geocore.runtime.prepare import assume_missing_crs, estimate_utm, repair_geometries

_STEP_REF_RE = re.compile(r"\A(ar_[A-Za-z0-9]{10,32})#([A-Za-z0-9_]{1,32})\Z")


def parse_step_ref(token: str):
    """`ar_xxx#stepId` → (artifact_id, step_id)；否则 None。"""
    m = _STEP_REF_RE.fullmatch(str(token))
    return (m.group(1), m.group(2)) if m else None


class DatasetResolver:
    def __init__(self, store, crs_override: str | None = None):
        self.store = store
        self.warnings: list[str] = []
        self.inputs_meta: list[dict] = []
        self._frames: dict[str, gpd.GeoDataFrame] = {}
        self._provenance: dict[str, dict] = {}
        self._crs_sources: dict[str, str] = {}
        self._analysis_crs = None
        self._crs_override = crs_override

    # ------------------------------------------------------------- resolution

    def register_step(self, step_id: str, gdf: gpd.GeoDataFrame) -> None:
        self._frames[f"@{step_id}"] = gdf
        self._provenance[f"@{step_id}"] = {"kind": "step", "step": step_id, "crs": str(gdf.crs)}

    def _resolve_source(self, token: str) -> tuple[gpd.GeoDataFrame | None, dict]:
        """Load an unnormalized source; None token means @step hit earlier."""
        prov: dict = {}
        if is_artifact_token(token):
            path = self.store.resolve_result_path(str(token))
            gdf, prov = load_dataset(str(path))
            prov["artifact"] = str(token)
            return gdf, prov
        step_ref = _STEP_REF_RE.fullmatch(str(token))
        if step_ref:
            art_id, step_id = step_ref.group(1), step_ref.group(2)
            # 校验 artifact 存在，再读取其中持久化的中间步骤图层
            self.store.get(art_id)
            path = self.store.resolve_result_path(art_id)
            gdf, prov = load_dataset(str(path), layer=f"step_{step_id}")
            prov["artifact"] = art_id
            prov["step"] = step_id
            return gdf, prov
        path = Path(str(token))
        if not path.is_absolute():
            hint = {"token": str(token)}
            raise GeoCoreError(E_INPUT_MISSING, f"输入不存在：{path}", hint)
        gdf, prov = load_dataset(str(path))
        return gdf, prov

    def _choose_analysis_crs(self, gdf: gpd.GeoDataFrame) -> None:
        if self._analysis_crs is not None:
            return
        src = gdf.crs

        if self._crs_override:
            if self._crs_override.lower() in ("source", "keep", "keep_source"):
                # 保持首个输入的坐标系；缺失 CRS 时仍回退 UTM（无法度量）
                if src is not None:
                    self._analysis_crs = src
                else:
                    self._analysis_crs = estimate_utm(gdf)
                return
            from pyproj import CRS

            try:
                self._analysis_crs = CRS.from_user_input(self._crs_override)
            except Exception as exc:
                raise GeoCoreError(
                    E_BAD_REQUEST,
                    f"crs 参数无法解析：{self._crs_override!r}（示例：'EPSG:32622' 或 'source'）",
                    {"crs": self._crs_override},
                ) from exc
            return

        if src is not None and src.is_projected:
            try:
                unit = (src.axis_info[0].unit_name or "").lower()
            except Exception:
                unit = ""
            if any(u in unit for u in ("metre", "meter", "foot")):
                self._analysis_crs = src
            else:                       # 投影但非长度单位：退回 UTM
                self._analysis_crs = estimate_utm(gdf)
            return
        # 地理坐标系输入：按数据范围选 UTM
        self._analysis_crs = estimate_utm(gdf)

    # ------------------------------------------------------------------ read

    def frame(self, token: str) -> tuple[gpd.GeoDataFrame, dict]:
        key = str(token)
        cached = self._frames.get(key)
        if cached is not None:
            return cached, self._provenance[key]

        gdf, prov = self._resolve_source(key)
        name = prov.get("format", "input") + ":" + key
        gdf = assume_missing_crs(gdf, prov.get("format", key), self.warnings)
        gdf = repair_geometries(gdf, self.warnings)

        was_none = self._analysis_crs is None
        origin = gdf.crs.to_string() if gdf.crs is not None else "<无CRS>"
        self._choose_analysis_crs(gdf)
        target = self._analysis_crs
        self._crs_sources[name] = origin
        if target is not None and gdf.crs != target:
            self.warnings.append(
                f"{name} 已从 {origin} 统一重投影到分析坐标系 {target.to_string()}"
            )
            gdf = gdf.to_crs(target)

        if was_none and self._analysis_crs is not None:
            self.warnings.insert(0, f"本次分析的统一坐标系：{self._analysis_crs.to_string()}")

        prov_out = {
            "ref": key,
            "format": prov.get("format"),
            "path": prov.get("path"),
            "layer": prov.get("layer"),
            "count": int(len(gdf)),
        }
        if prov.get("artifact"):
            prov_out["artifact"] = prov["artifact"]
        if prov.get("step"):
            prov_out["step"] = prov["step"]
        self.inputs_meta.append(prov_out)
        self._frames[key] = gdf
        self._provenance[key] = prov_out
        return gdf, prov_out

    def crs_info(self) -> dict:
        target = self._analysis_crs.to_string() if self._analysis_crs is not None else ""
        return {"analysis": target, "sources": dict(self._crs_sources)}
