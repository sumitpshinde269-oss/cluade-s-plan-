import { NextResponse } from 'next/server'
import { performServerlessInspection } from '@/lib/serverlessInspection'

export async function POST(req: Request) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ detail: 'No file uploaded.' }, { status: 400 })
    }

    const backendUrl = process.env.BACKEND_URL
    if (backendUrl) {
      try {
        const remoteRes = await fetch(`${backendUrl}/api/v1/analysis/image`, {
          method: 'POST',
          body: formData,
        })
        if (remoteRes.ok) return NextResponse.json(await remoteRes.json())
      } catch (err) {
        // Fall back to serverless computer vision engine
      }
    }

    // Execute serverless computer vision inspection on uploaded file bytes
    const arrayBuf = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuf)
    const inspectionResult = performServerlessInspection(buffer, file.name || 'upload.jpg')

    return NextResponse.json(inspectionResult, { status: 200 })
  } catch (err: any) {
    return NextResponse.json(
      { detail: err.message || 'Image processing failed.' },
      { status: 500 }
    )
  }
}
