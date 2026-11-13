// Server-side proxy to the PitScout backend. Keeps the API key on the server and streams
// request/response bodies (uploads can be hundreds of MB). Only an allowlist of backend paths
// is reachable; admin/training endpoints are NOT exposed through here.
import { NextResponse } from 'next/server'

const BACKEND = process.env.BACKEND_URL || 'http://localhost:8000'
const API_KEY = process.env.ROADGUARD_API_KEY || 'roadguard-production-api-key-2026'
const ALLOWED = ['pothole-reports', 'videos', 'potholes', 'map', 'pitscout', 'detections']

function target(path: string[], search: string): string | null {
  if (path.some((p) => p === '..' || p === '.' || p.includes('\\'))) return null
  if (path[0] === 'evidence') return `${BACKEND}/static/evidence/${path.slice(1).join('/')}`
  if (!ALLOWED.includes(path[0])) return null
  return `${BACKEND}/api/v1/${path.join('/')}${search}`
}

async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params
  const url = target(path, new URL(req.url).search)
  if (!url) return NextResponse.json({ detail: 'Not found' }, { status: 404 })

  const headers = new Headers({ 'X-API-Key': API_KEY })
  for (const h of ['content-type', 'idempotency-key', 'x-reporter-id']) {
    const v = req.headers.get(h)
    if (v) headers.set(h, v)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  try {
    const res = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // @ts-expect-error duplex is required by Node fetch for streamed request bodies
      duplex: 'half',
      cache: 'no-store',
    })
    const out = new Headers()
    for (const h of ['content-type', 'content-length', 'cache-control']) {
      const v = res.headers.get(h)
      if (v) out.set(h, v)
    }
    return new Response(res.body, { status: res.status, headers: out })
  } catch {
    return NextResponse.json(
      { detail: 'PitScout backend is unreachable. Start it (see README) or set BACKEND_URL.' },
      { status: 503 }
    )
  }
}

export const GET = forward
export const POST = forward
export const PATCH = forward
