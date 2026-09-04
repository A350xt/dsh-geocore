"""Thematic map rendering (matplotlib, offline)."""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

DEFAULT_CMAP = "YlOrRd"
_CLASSIFICATIONS = ("quantile", "equal_interval")


def _hex(color) -> str | None:
    """校验调用方给的类别色是 #RRGGBB/#RGB 形式，防注入 matplotlib 之外的解析。"""
    s = str(color).strip()
    return s if len(s) in (4, 7) and s.startswith("#") else None


def _classification(values, n_classes: int, method: str):
    import numpy as np

    v = values.dropna().astype(float)
    if len(v) == 0:
        return [0.0, 1.0]
    if method == "equal_interval":
        lo, hi = float(v.min()), float(v.max())
        return list(np.linspace(lo, hi, max(2, n_classes) + 1))
    qs = np.quantile(v.to_numpy(), [i / max(2, n_classes) for i in range(max(2, n_classes) + 1)])
    return sorted({float(q) for q in qs})


def render_map(gdf, *, style: dict, out_path: Path, title: str,
               base_gdf=None, base_style: dict | None = None) -> list[str]:
    """Render `gdf` (可叠加 `base_gdf` 底图层) into out_path; returns legend entries.

    style 支持：
    - mode: single | categorical | choropleth | point
    - categorical 模式：category_colors {"类别值": "#rrggbb"} 显式指定类色
    - point 模式：size_field + size_range [min, max] 按数值字段缩放点径
    """
    mode = str(style.get("mode") or style.get("type") or "single").lower()
    figsize = tuple(style.get("figsize", [10, 8]))
    dpi = int(style.get("dpi", 150))
    color = str(style.get("color", "#3b82f6"))

    fig, ax = plt.subplots(figsize=figsize)
    ax.set_aspect("equal")
    legend_entries: list[str] = []

    # ---- 底图层先画（中性色垫底，如陆地/行政区范围） ----
    if base_gdf is not None and len(base_gdf) > 0:
        bs = base_style or {}
        base_gdf.plot(
            ax=ax,
            color=str(bs.get("color", "#e8eaed")),
            edgecolor=str(bs.get("edgecolor", "#ffffff")),
            linewidth=float(bs.get("linewidth", 0.4)),
            alpha=float(bs.get("alpha", 1.0)),
            zorder=1,
        )

    try:
        if mode in ("categorical", "category"):
            field = style.get("field")
            if not field or field not in gdf.columns:
                raise ValueError(f"categorical 模式需要有效字段：{field!r}")
            filled = gdf[field].fillna("<空>").astype(str)
            cats = sorted(filled.unique())
            overrides = style.get("category_colors") or {}
            if not isinstance(overrides, dict):
                raise ValueError("category_colors 必须是 {类别值: '#rrggbb'} 映射")
            cmap = plt.get_cmap("tab20", max(len(cats), 1))
            colors: dict[str, object] = {}
            unresolved = []
            for i, c in enumerate(cats):
                explicit = _hex(overrides.get(c))
                if explicit:
                    colors[c] = explicit
                else:
                    if str(c) in overrides:
                        unresolved.append(str(c))
                    colors[c] = cmap(i % 20)
            if unresolved:
                raise ValueError(
                    f"category_colors 中这些值不是 #rrggbb 颜色：{unresolved}（注意键需与字段值完全一致）"
                )
            gdf.plot(ax=ax, color=[colors[c] for c in filled],
                     edgecolor="white", linewidth=0.6, zorder=2)
            handles = [Patch(facecolor=colors[c], label=str(c)) for c in cats]
            ax.legend(handles=handles, loc="lower left", fontsize=9, title=str(field))
            legend_entries = [f"{field}={c}" for c in cats]

        elif mode in ("choropleth", "graded"):
            field = style.get("field")
            if not field or field not in gdf.columns:
                raise ValueError(f"choropleth 模式需要有效数值字段：{field!r}")
            method = str(style.get("classification", "quantile")).lower()
            if method not in _CLASSIFICATIONS:
                raise ValueError(f"不支持的分级方式:{method}（可选 {list(_CLASSIFICATIONS)}）")
            n_classes = max(2, min(int(style.get("classes", 5)), 9))
            breaks = _classification(gdf[field], n_classes, method)
            cmap_name = str(style.get("cmap", DEFAULT_CMAP))
            gdf.plot(ax=ax, column=field, cmap=cmap_name, edgecolor="white",
                     linewidth=0.5, scheme=None,
                     legend=False,
                     missing_kwds={"color": "#cccccc", "label": "无数据"})
            import matplotlib.cm as cm
            import numpy as np

            cmap_obj = plt.get_cmap(cmap_name)
            norm = matplotlib.colors.Normalize(vmin=breaks[0], vmax=breaks[-1])
            handles = []
            labels = []
            for i in range(len(breaks) - 1):
                mid = (breaks[i] + breaks[i + 1]) / 2
                handles.append(Patch(facecolor=cmap_obj(norm(mid))))
                unit = "%" if field.endswith("_pct") else ""
                labels.append(f"{breaks[i]:,.4g} ~ {breaks[i + 1]:,.4g}{unit}")
            ax.legend(handles, labels, loc="lower left", fontsize=8, title=f"{field}（{method}）")
            legend_entries = labels

        elif mode == "point":
            size = float(style.get("size", 25))
            size_field = style.get("size_field")
            if size_field:
                if size_field not in gdf.columns:
                    raise ValueError(f"size_field 不存在：{size_field!r}")
                vals = gdf[size_field].astype(float)
                vmin, vmax = float(vals.min()), float(vals.max())
                lo, hi = style.get("size_range", [12, 180])
                lo, hi = float(lo), float(hi)
                span = (vmax - vmin) or 1.0
                sizes = lo + (vals - vmin) / span * (hi - lo)
                gdf.plot(ax=ax, color=color, markersize=sizes,
                         edgecolor="white", linewidth=0.5, zorder=3)
                legend_entries = [f"点径 ∝ {size_field}（{vmin:.4g} → {vmax:.4g}）"]
            else:
                gdf.plot(ax=ax, color=color, markersize=size,
                         edgecolor="white", linewidth=0.5, zorder=3)
                legend_entries = []

        else:  # single
            fam_point = set(map(str, gdf.geometry.geom_type)) <= {"Point", "MultiPoint"}
            if fam_point:
                gdf.plot(ax=ax, color=color, markersize=float(style.get("size", 25)),
                         edgecolor="white", linewidth=0.5, zorder=3)
            else:
                gdf.plot(ax=ax, color=color, alpha=0.75, edgecolor="white",
                         linewidth=0.7, zorder=3)

        ax.set_title(title, fontsize=14)
        ax.set_axis_off()
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(out_path, dpi=dpi, bbox_inches="tight", facecolor="white")
        return legend_entries
    finally:
        plt.close(fig)


def render_bar_chart(labels: list[str], values: list[float], *, out_path: Path,
                     title: str, ylabel: str = "") -> None:
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.bar(range(len(labels)), values, color="#3b82f6")
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=30, ha="right", fontsize=9)
    ax.set_title(title)
    if ylabel:
        ax.set_ylabel(ylabel)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150, facecolor="white")
    plt.close(fig)
