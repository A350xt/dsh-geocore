"""Wire protocol shared by CLI, bridge tests and the DSH plugin.

Every command emits a single JSON envelope on stdout:

    {"ok": true,  "result": {...}}
    {"ok": false, "error": {"code": "...", "message": "...", "details": {...}}}

This module is the single source of truth for error codes.
"""

from __future__ import annotations

from typing import Any

# Error codes (stable contract, see docs/tool-api.md)
E_BAD_REQUEST = "E_BAD_REQUEST"                    # malformed request / invalid params
E_INPUT_MISSING = "E_INPUT_MISSING"                # dataset path or artifact id not found
E_CRS_AMBIGUOUS = "E_CRS_AMBIGUOUS"                # missing CRS that cannot be assumed safely
E_OP_UNKNOWN = "E_OP_UNKNOWN"                      # operation not in the primitive vocabulary
E_GEOMETRY_INVALID_UNFIXABLE = "E_GEOMETRY_INVALID_UNFIXABLE"  # make_valid failed
E_EMPTY_RESULT = "E_EMPTY_RESULT"                  # an operation produced zero features
E_OUTPUT_ERROR = "E_OUTPUT_ERROR"                  # failed writing artifact/map
E_INTERNAL = "E_INTERNAL"                          # unexpected failure


class GeoCoreError(Exception):
    """Domain error carrying a stable wire code."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def ok_envelope(result: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "result": result}


def error_envelope(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message, "details": details or {}}}


def envelope_from_exception(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, GeoCoreError):
        return error_envelope(exc.code, exc.message, exc.details)
    return error_envelope(E_INTERNAL, f"{type(exc).__name__}: {exc}")
