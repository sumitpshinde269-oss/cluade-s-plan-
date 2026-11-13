// Typed client for the PitScout API (goes through the /api/pitscout server proxy).

export type MatchStatus = 'new' | 'matched' | 'uncertain' | 'pending_location'
export type Lifecycle = 'reported' | 'verified' | 'scheduled' | 'repaired' | 'rejected'
export const LIFECYCLES: Lifecycle[] = ['reported', 'verified', 'scheduled', 'repaired', 'rejected']

export interface Candidate {
  pothole_id: string
  distance_m: number
  radius_m: number
  visual_sim: number | null
  size_ratio: number
  score: number
}
export interface Detection {
  id: string
  pothole_id: string | null
  match_status: MatchStatus
  confidence: number
  bbox: [number, number, number, number]
  image_width: number
  image_height: number
  frame_index: number | null
  timestamp_s: number | null
  track_id: number | null
  evidence_url: string | null
  report_id?: string
  match_meta: { reason?: string; candidates?: Candidate[]; resolved_by?: string } | null
}
export interface Loc {
  lat: number
  lon: number
  accuracy_m: number | null
  source: 'gps' | 'manual'
  verified?: boolean
}
export interface Report {
  id: string
  created_at: string
  source: 'image' | 'video'
  status: string
  location_status: 'verified' | 'unverified' | 'pending'
  original_filename: string | null
  video_job_id: string | null
  location: Loc | null
  detections: Detection[]
  summary: Record<MatchStatus, number>
  idempotent_replay?: boolean
}
export interface Pothole {
  id: string
  lat: number
  lon: number
  lifecycle_status: Lifecycle
  verification_status: string
  report_count: number
  best_confidence: number
  created_at: string
  updated_at: string
  detections?: Detection[]
  reports?: { id: string; created_at: string; source: string; location_status: string; location: Loc | null }[]
  status_history?: { from: string | null; to: string; note: string | null; actor: string | null; at: string }[]
}
export interface Frame {
  frame_index: number
  timestamp_s: number
  bbox: [number, number, number, number]
  confidence: number
}
export interface Track {
  track_id: number
  confirmed: boolean
  hits: number
  first_timestamp_s: number
  last_timestamp_s: number
  best_confidence: number
  mean_confidence: number
  best_frame_index: number
  best_bbox: [number, number, number, number]
  image_width: number
  image_height: number
  evidence_url: string
  frames: Frame[]
}
export interface VideoJob {
  id: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  progress: number
  error: string | null
  original_filename: string | null
  created_at: string
  summary?: { sampled_frames: number; frames_with_detections: number; raw_detections: number; total_unique_potholes: number; unconfirmed_tracks: number }
  result?: {
    video: { fps: number; duration_s: number | null; width: number; height: number; stride: number; sample_fps: number }
    min_track_hits: number
    tracks: Track[]
  } & NonNullable<VideoJob['summary']>
}

const BASE = '/api/pitscout'

export const evidenceSrc = (url: string | null | undefined) =>
  url ? `${BASE}/evidence/${url.replace(/^\/static\/evidence\//, '')}` : ''

export const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')

export function errorText(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object' && 'message' in detail) return String((detail as { message: unknown }).message)
  return 'Request failed'
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(errorText(body.detail ?? body))
  return body as T
}

export const ps = {
  get: <T,>(path: string) => fetch(`${BASE}/${path}`, { cache: 'no-store' }).then((r) => parse<T>(r)),
  send: <T,>(method: 'POST' | 'PATCH', path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${BASE}/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }).then((r) => parse<T>(r)),
  upload: <T,>(path: string, form: FormData, headers: Record<string, string> = {}, onProgress?: (p: number) => void) =>
    new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${BASE}/${path}`)
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v))
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
      xhr.onerror = () => reject(new Error('Network error'))
      xhr.onload = () => {
        let body: { detail?: unknown } = {}
        try {
          body = JSON.parse(xhr.responseText)
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as T)
        else reject(new Error(errorText(body.detail ?? body)))
      }
      xhr.send(form)
    }),
}

export const locationToForm = (form: FormData, loc: Loc | null) => {
  if (!loc) return
  form.set('latitude', String(loc.lat))
  form.set('longitude', String(loc.lon))
  if (loc.accuracy_m != null) form.set('accuracy_m', String(loc.accuracy_m))
  form.set('location_source', loc.source)
}

export const locationToJson = (loc: Loc | null) =>
  loc ? { latitude: loc.lat, longitude: loc.lon, accuracy_m: loc.accuracy_m, location_source: loc.source } : {}
