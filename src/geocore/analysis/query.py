"""Query & Measure handlers."""

from __future__ import annotations

from geocore.analysis.common import StepResult, need, opt
from geocore.providers.geostack import PROVIDER


def handle_filter(resolver, params: dict, step_id: str) -> StepResult:
    where = str(need(params, "where", "query.filter"))
    gdf, _ = resolver.frame(need(params, "input", "query.filter"))
    n_before = len(gdf)
    out = PROVIDER.filter_attributes(gdf, where)
    return StepResult(
        out,
        [f"属性过滤 `{where}`：{len(out)} 条命中（原 {n_before} 条）"],
    )


def handle_select(resolver, params: dict, step_id: str) -> StepResult:
    predicate = str(opt(params, "predicate", "intersects"))
    ref_tok = need(params, "ref", "query.select")
    gdf, _ = resolver.frame(need(params, "input", "query.select"))
    ref, _ = resolver.frame(ref_tok)
    n_before = len(gdf)
    out = PROVIDER.select_spatial(gdf, predicate, ref)
    return StepResult(out, [f"空间选择（{predicate} 参照层）命中 {len(out)} 条（原 {n_before} 条）"])


def handle_measure(resolver, params: dict, step_id: str) -> StepResult:
    measures = list(opt(params, "measures", ["count"]))
    gdf, _ = resolver.frame(need(params, "input", "query.measure"))
    out, totals = PROVIDER.measure(gdf, measures)
    parts = []
    if "area_sqkm_sum" in totals:
        parts.append(f"总面积 {totals['area_sqkm_sum']:.3f} km²")
        if "area_ha_sum" in totals:
            parts.append(f"{totals['area_ha_sum']:.1f} ha")
    if "length_km_sum" in totals:
        parts.append(f"总长度 {totals['length_km_sum']:.3f} km")
    if "count" in totals:
        parts.append(f"共 {int(totals['count'])} 条要素")
    return StepResult(out, ["度量结果：" + "；".join(parts)])


SPEC = {
    "query.filter": handle_filter,
    "query.select": handle_select,
    "query.measure": handle_measure,
}
