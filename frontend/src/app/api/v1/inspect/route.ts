import { NextResponse } from 'next/server'
import { performServerlessInspection } from '@/lib/serverlessInspection'

const EXPECTED_KEY = process.env.ROADGUARD_API_KEY || 'roadguard-production-api-key-2026'

export async function POST(req: Request) {
  // Check authorization header
  const authHeader = req.headers.get('authorization') || ''
  const apiKeyHeader = req.headers.get('x-api-key') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim() || apiKeyHeader.trim()

  if (!token) {
    return NextResponse.json(
      { detail: "Authentication required. Provide 'Authorization: Bearer <API_KEY>' or 'X-API-Key' header." },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    )
  }

  if (token !== EXPECTED_KEY) {
    return NextResponse.json(
      { detail: 'Invalid API key provided.' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    )
  }

  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null

    const backendUrl = process.env.BACKEND_URL
    if (backendUrl) {
      try {
        const res = await fetch(`${backendUrl}/api/v1/inspect`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        })
        if (res.ok) return NextResponse.json(await res.json())
      } catch {}
    }

    if (!file) {
      return NextResponse.json({ detail: 'No file provided in request.' }, { status: 400 })
    }

    const arrayBuf = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuf)
    const inspectionResult = performServerlessInspection(buffer, file.name || 'upload.jpg')

    return NextResponse.json(inspectionResult, { status: 200 })
  } catch (err: any) {
    return NextResponse.json({ detail: err.message || 'Inspection error' }, { status: 500 })
  }
}
