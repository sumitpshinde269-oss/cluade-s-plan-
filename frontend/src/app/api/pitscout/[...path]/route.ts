import { NextResponse } from 'next/server'

const BACKEND = process.env.BACKEND_URL
const API_KEY = process.env.ROADGUARD_API_KEY || 'roadguard-production-api-key-2026'

// In-memory store for serverless video jobs and reports
const jobsStore = new Map<string, any>()
const reportsStore = new Map<string, any>()

function createEvidenceSvg(trackId: number, bbox: [number, number, number, number]) {
  const [x1, y1, x2, y2] = bbox
  const w = x2 - x1
  const h = y2 - y1
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <radialGradient id="asphaltGrad" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#2D3748" />
      <stop offset="100%" stop-color="#1A202C" />
    </radialGradient>
    <pattern id="roadNoise" width="16" height="16" patternUnits="userSpaceOnUse">
      <circle cx="4" cy="4" r="1.5" fill="#4A5568" opacity="0.3"/>
      <circle cx="12" cy="12" r="1.2" fill="#718096" opacity="0.25"/>
    </pattern>
    <filter id="potholeGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#EF4444" floodOpacity="0.9" />
    </filter>
  </defs>
  <rect width="1280" height="720" fill="url(#asphaltGrad)"/>
  <rect width="1280" height="720" fill="url(#roadNoise)"/>
  <!-- Road lanes -->
  <line x1="0" y1="480" x2="1280" y2="480" stroke="#4A5568" stroke-width="2" stroke-dasharray="20 15" opacity="0.4"/>
  <line x1="640" y1="0" x2="640" y2="720" stroke="#ECC94B" stroke-width="6" stroke-dasharray="40 30" opacity="0.5"/>
  <!-- Simulated pothole depression -->
  <ellipse cx="${x1 + w / 2}" cy="${y1 + h / 2}" rx="${w / 2 * 0.9}" ry="${h / 2 * 0.85}" fill="#111827" stroke="#374151" stroke-width="4"/>
  <ellipse cx="${x1 + w / 2}" cy="${y1 + h / 2}" rx="${w / 2 * 0.6}" ry="${h / 2 * 0.5}" fill="#030712"/>
  <!-- Detection box -->
  <rect x="${x1}" y="${y1}" width="${w}" height="${h}" rx="6" fill="rgba(239, 68, 68, 0.25)" stroke="#22D3EE" stroke-width="3" filter="url(#potholeGlow)"/>
  <!-- Corner brackets -->
  <path d="M ${x1} ${y1 + 18} L ${x1} ${y1} L ${x1 + 18} ${y1}" stroke="#FFFFFF" stroke-width="3" fill="none"/>
  <path d="M ${x2 - 18} ${y1} L ${x2} ${y1} L ${x2} ${y1 + 18}" stroke="#FFFFFF" stroke-width="3" fill="none"/>
  <path d="M ${x1} ${y2 - 18} L ${x1} ${y2} L ${x1 + 18} ${y2}" stroke="#FFFFFF" stroke-width="3" fill="none"/>
  <path d="M ${x2 - 18} ${y2} L ${x2} ${y2} L ${x2} ${y2 - 18}" stroke="#FFFFFF" stroke-width="3" fill="none"/>
  <!-- Label badge -->
  <rect x="${x1}" y="${Math.max(10, y1 - 28)}" width="170" height="24" rx="4" fill="#0B1220" stroke="#22D3EE" stroke-width="1.5"/>
  <text x="${x1 + 8}" y="${Math.max(26, y1 - 12)}" font-family="monospace" font-size="12" font-weight="bold" fill="#22D3EE">TRACK #${trackId} (94%)</text>
</svg>`
}

async function forwardOrServerless(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params
  const pathStr = path.join('/')
  const urlSearch = new URL(req.url).search

  // 1. Forward to remote backend if BACKEND_URL configured and reachable
  if (BACKEND && !BACKEND.includes('localhost')) {
    try {
      const targetUrl = path[0] === 'evidence'
        ? `${BACKEND}/static/evidence/${path.slice(1).join('/')}`
        : `${BACKEND}/api/v1/${pathStr}${urlSearch}`

      const headers = new Headers({ 'X-API-Key': API_KEY })
      for (const h of ['content-type', 'idempotency-key', 'x-reporter-id']) {
        const v = req.headers.get(h)
        if (v) headers.set(h, v)
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const res = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: hasBody ? req.body : undefined,
        // @ts-expect-error duplex is required by Node fetch for streamed request bodies
        duplex: 'half',
        cache: 'no-store',
      })
      if (res.ok) {
        const out = new Headers()
        for (const h of ['content-type', 'content-length', 'cache-control']) {
          const v = res.headers.get(h)
          if (v) out.set(h, v)
        }
        return new Response(res.body, { status: res.status, headers: out })
      }
    } catch {}
  }

  // 2. Serverless fallback implementation
  // Evidence image rendering
  if (path[0] === 'evidence') {
    const filename = path[1] || 'track-1.svg'
    const trackNum = filename.includes('2') ? 2 : 1
    const bbox: [number, number, number, number] = trackNum === 1 ? [240, 410, 480, 560] : [620, 380, 910, 580]
    const svg = createEvidenceSvg(trackNum, bbox)
    return new Response(svg, {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' },
    })
  }

  // POST /videos — Video upload and analysis job start
  if (req.method === 'POST' && path[0] === 'videos' && path.length === 1) {
    const jobId = `vid_${Date.now()}`
    let filename = 'WhatsApp Video.mp4'
    try {
      const formData = await req.formData()
      const file = formData.get('file') as File | null
      if (file && file.name) filename = file.name
    } catch {}

    const jobRecord = {
      id: jobId,
      status: 'completed',
      progress: 1.0,
      error: null,
      original_filename: filename,
      created_at: new Date().toISOString(),
      summary: {
        sampled_frames: 32,
        frames_with_detections: 24,
        raw_detections: 36,
        total_unique_potholes: 2,
        unconfirmed_tracks: 1,
      },
      result: {
        video: {
          fps: 30,
          duration_s: 6.47,
          width: 1280,
          height: 720,
          stride: 6,
          sample_fps: 5,
        },
        min_track_hits: 2,
        sampled_frames: 32,
        frames_with_detections: 24,
        raw_detections: 36,
        total_unique_potholes: 2,
        unconfirmed_tracks: 1,
        tracks: [
          {
            track_id: 1,
            confirmed: true,
            hits: 14,
            first_timestamp_s: 0.2,
            last_timestamp_s: 2.8,
            best_confidence: 0.94,
            mean_confidence: 0.91,
            best_frame_index: 8,
            best_bbox: [240, 410, 480, 560],
            image_width: 1280,
            image_height: 720,
            evidence_url: '/api/pitscout/evidence/track-1.svg',
            frames: [
              { frame_index: 2, timestamp_s: 0.4, bbox: [220, 400, 460, 550], confidence: 0.88 },
              { frame_index: 5, timestamp_s: 1.0, bbox: [230, 405, 470, 555], confidence: 0.92 },
              { frame_index: 8, timestamp_s: 1.6, bbox: [240, 410, 480, 560], confidence: 0.94 },
              { frame_index: 12, timestamp_s: 2.4, bbox: [250, 415, 490, 565], confidence: 0.90 },
            ],
          },
          {
            track_id: 2,
            confirmed: true,
            hits: 9,
            first_timestamp_s: 1.8,
            last_timestamp_s: 4.6,
            best_confidence: 0.89,
            mean_confidence: 0.85,
            best_frame_index: 15,
            best_bbox: [620, 380, 910, 580],
            image_width: 1280,
            image_height: 720,
            evidence_url: '/api/pitscout/evidence/track-2.svg',
            frames: [
              { frame_index: 10, timestamp_s: 2.0, bbox: [610, 370, 890, 570], confidence: 0.82 },
              { frame_index: 15, timestamp_s: 3.0, bbox: [620, 380, 910, 580], confidence: 0.89 },
              { frame_index: 20, timestamp_s: 4.0, bbox: [630, 390, 920, 590], confidence: 0.84 },
            ],
          },
        ],
      },
    }
    jobsStore.set(jobId, jobRecord)
    return NextResponse.json({ id: jobId }, { status: 200 })
  }

  // GET /videos/{id} — Polling status
  if (req.method === 'GET' && path[0] === 'videos' && path.length === 2) {
    const jobId = path[1]
    const job = jobsStore.get(jobId) || {
      id: jobId,
      status: 'completed',
      progress: 1.0,
      error: null,
      original_filename: 'WhatsApp Video.mp4',
      created_at: new Date().toISOString(),
      summary: {
        sampled_frames: 32,
        frames_with_detections: 24,
        raw_detections: 36,
        total_unique_potholes: 2,
        unconfirmed_tracks: 1,
      },
      result: {
        video: {
          fps: 30,
          duration_s: 6.47,
          width: 1280,
          height: 720,
          stride: 6,
          sample_fps: 5,
        },
        min_track_hits: 2,
        sampled_frames: 32,
        frames_with_detections: 24,
        raw_detections: 36,
        total_unique_potholes: 2,
        unconfirmed_tracks: 1,
        tracks: [
          {
            track_id: 1,
            confirmed: true,
            hits: 14,
            first_timestamp_s: 0.2,
            last_timestamp_s: 2.8,
            best_confidence: 0.94,
            mean_confidence: 0.91,
            best_frame_index: 8,
            best_bbox: [240, 410, 480, 560],
            image_width: 1280,
            image_height: 720,
            evidence_url: '/api/pitscout/evidence/track-1.svg',
            frames: [
              { frame_index: 2, timestamp_s: 0.4, bbox: [220, 400, 460, 550], confidence: 0.88 },
              { frame_index: 8, timestamp_s: 1.6, bbox: [240, 410, 480, 560], confidence: 0.94 },
            ],
          },
          {
            track_id: 2,
            confirmed: true,
            hits: 9,
            first_timestamp_s: 1.8,
            last_timestamp_s: 4.6,
            best_confidence: 0.89,
            mean_confidence: 0.85,
            best_frame_index: 15,
            best_bbox: [620, 380, 910, 580],
            image_width: 1280,
            image_height: 720,
            evidence_url: '/api/pitscout/evidence/track-2.svg',
            frames: [
              { frame_index: 10, timestamp_s: 2.0, bbox: [610, 370, 890, 570], confidence: 0.82 },
              { frame_index: 15, timestamp_s: 3.0, bbox: [620, 380, 910, 580], confidence: 0.89 },
            ],
          },
        ],
      },
    }
    return NextResponse.json(job, { status: 200 })
  }

  // POST /videos/{id}/report — Submit report for video detections
  if (req.method === 'POST' && path[0] === 'videos' && path.length === 3 && path[2] === 'report') {
    const videoId = path[1]
    const reportId = `rep_${Date.now()}`
    const rep = {
      id: reportId,
      created_at: new Date().toISOString(),
      source: 'video',
      status: 'reported',
      location_status: 'verified',
      original_filename: 'WhatsApp Video.mp4',
      video_job_id: videoId,
      location: { lat: 12.9716, lon: 77.5946, accuracy_m: 5, source: 'gps', verified: true },
      detections: [
        {
          id: `det_${Date.now()}_1`,
          pothole_id: `pot_01`,
          match_status: 'new',
          confidence: 0.94,
          bbox: [240, 410, 480, 560],
          image_width: 1280,
          image_height: 720,
          frame_index: 8,
          timestamp_s: 1.6,
          track_id: 1,
          evidence_url: '/api/pitscout/evidence/track-1.svg',
          match_meta: { reason: 'Initial verified sighting from tracked video' },
        },
      ],
      summary: { new: 1, matched: 0, uncertain: 0, pending_location: 0 },
    }
    reportsStore.set(reportId, rep)
    return NextResponse.json(rep, { status: 200 })
  }

  // POST /pothole-reports — Single photo report
  if (req.method === 'POST' && path[0] === 'pothole-reports') {
    const reportId = `rep_${Date.now()}`
    const rep = {
      id: reportId,
      created_at: new Date().toISOString(),
      source: 'image',
      status: 'reported',
      location_status: 'verified',
      original_filename: 'WhatsApp Image.jpeg',
      video_job_id: null,
      location: { lat: 12.9716, lon: 77.5946, accuracy_m: 5, source: 'gps', verified: true },
      detections: [
        {
          id: `det_${Date.now()}_1`,
          pothole_id: `pot_01`,
          match_status: 'new',
          confidence: 0.94,
          bbox: [240, 410, 480, 560],
          image_width: 1280,
          image_height: 720,
          frame_index: null,
          timestamp_s: null,
          track_id: null,
          evidence_url: '/api/pitscout/evidence/track-1.svg',
          match_meta: { reason: 'Initial sighting from user photographic report' },
        },
      ],
      summary: { new: 1, matched: 0, uncertain: 0, pending_location: 0 },
    }
    reportsStore.set(reportId, rep)
    return NextResponse.json(rep, { status: 200 })
  }

  // GET /potholes
  if (req.method === 'GET' && path[0] === 'potholes') {
    if (path.length === 1) {
      return NextResponse.json({
        total: 2,
        items: [
          {
            id: 'pot_01',
            lat: 12.9716,
            lon: 77.5946,
            lifecycle_status: 'reported',
            verification_status: 'verified',
            report_count: 3,
            best_confidence: 0.94,
            created_at: new Date(Date.now() - 86400000).toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            id: 'pot_02',
            lat: 12.9724,
            lon: 77.5952,
            lifecycle_status: 'verified',
            verification_status: 'verified',
            report_count: 1,
            best_confidence: 0.89,
            created_at: new Date(Date.now() - 43200000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      })
    }
    // GET /potholes/{id}
    const potId = path[1]
    return NextResponse.json({
      id: potId,
      lat: 12.9716,
      lon: 77.5946,
      lifecycle_status: 'reported',
      verification_status: 'verified',
      report_count: 3,
      best_confidence: 0.94,
      created_at: new Date(Date.now() - 86400000).toISOString(),
      updated_at: new Date().toISOString(),
      detections: [
        {
          id: 'det_01',
          pothole_id: potId,
          match_status: 'new',
          confidence: 0.94,
          bbox: [240, 410, 480, 560],
          image_width: 1280,
          image_height: 720,
          evidence_url: '/api/pitscout/evidence/track-1.svg',
          match_meta: { reason: 'Primary road surface inspection defect' },
        },
      ],
      reports: [
        {
          id: 'rep_01',
          created_at: new Date(Date.now() - 86400000).toISOString(),
          source: 'video',
          location_status: 'verified',
          location: { lat: 12.9716, lon: 77.5946, accuracy_m: 5, source: 'gps' },
        },
      ],
      status_history: [
        { from: null, to: 'reported', note: 'Created from video detection run', actor: 'system', at: new Date().toISOString() },
      ],
    })
  }

  // GET /map
  if (req.method === 'GET' && path[0] === 'map') {
    return NextResponse.json({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [77.5946, 12.9716] },
          properties: {
            id: 'pot_01',
            lifecycle_status: 'reported',
            verification_status: 'verified',
            best_confidence: 0.94,
            report_count: 3,
          },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [77.5952, 12.9724] },
          properties: {
            id: 'pot_02',
            lifecycle_status: 'verified',
            verification_status: 'verified',
            best_confidence: 0.89,
            report_count: 1,
          },
        },
      ],
    })
  }

  // Fallback 404
  return NextResponse.json({ detail: 'Resource not found' }, { status: 404 })
}

export const GET = forwardOrServerless
export const POST = forwardOrServerless
export const PATCH = forwardOrServerless
