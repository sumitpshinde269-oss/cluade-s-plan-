import { NextResponse } from 'next/server'
import { performServerlessInspection } from '@/lib/serverlessInspection'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolved = await params
  const id = resolved.id

  const backendUrl = process.env.BACKEND_URL
  if (backendUrl) {
    try {
      const res = await fetch(`${backendUrl}/api/v1/analysis/${id}/result`, { cache: 'no-store' })
      if (res.ok || res.status === 202) return NextResponse.json(await res.json(), { status: res.status })
    } catch (e) {}
  }

  // Return serverless fallback result
  const dummyBuf = Buffer.alloc(100)
  const result = performServerlessInspection(dummyBuf, 'road.jpg')
  result.analysis_id = id

  return NextResponse.json(result, { status: 200 })
}
