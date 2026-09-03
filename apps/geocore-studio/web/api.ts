/** 服务端 REST 封装。 */

export interface ApiError {
  code: string
  message: string
}

export interface Envelope<T> {
  ok: boolean
  result?: T
  error?: ApiError
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  let env: Envelope<T>
  try {
    env = (await res.json()) as Envelope<T>
  } catch {
    throw { code: 'E_HTTP', message: `HTTP ${res.status}` } as ApiError
  }
  if (!env.ok || env.error) {
    throw env.error ?? { code: 'E_HTTP', message: `HTTP ${res.status}` }
  }
  return env.result as T
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path)
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---------------- 数据形状 ----------------

export interface DatasetEntry {
  name: string
  path: string
  format: string
  size_bytes: number
}

export interface ArtifactEntry {
  artifact_id: string
  kind: string
  title: string
  created: string
  count: number
  geometry_types: string[]
  summary: string[]
  warnings: number
  steps: Array<{ id: string; op: string; count: number; summary: string }>
  intermediate_layers: Record<string, { layer: string; count: number }>
}

export interface Inventory {
  datasets: DatasetEntry[]
  artifacts: ArtifactEntry[]
}

export interface ReadResult {
  source: string
  geojson: any
  meta: {
    count_total: number
    count_returned: number
    truncated: boolean
    crs_source: string
    geometry_types: string[]
    fields: string[]
  }
  warnings: string[]
}

export interface AnalyzeResult {
  artifact_id: string
  title: string
  result: { path: string; format: string; count: number; geometry_types: string[] }
  summary: string[]
  steps: Array<{ id: string; op: string; count: number; summary: string }>
  warnings: string[]
  crs: { analysis: string; sources: Record<string, string> }
  intermediate_layers: Record<string, { layer: string; count: number }>
}
