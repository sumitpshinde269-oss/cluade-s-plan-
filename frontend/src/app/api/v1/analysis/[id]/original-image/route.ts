import { NextResponse } from 'next/server'

// Generates an SVG road surface representation if requested directly
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolved = await params
  const id = resolved.id

  const backendUrl = process.env.BACKEND_URL
  if (backendUrl) {
    try {
      const res = await fetch(`${backendUrl}/api/v1/analysis/${id}/original-image`, { cache: 'no-store' })
      if (res.ok) {
        const blob = await res.blob()
        return new Response(blob, {
          headers: { 'Content-Type': res.headers.get('content-type') || 'image/jpeg' },
        })
      }
    } catch {}
  }

  // Fallback high-contrast road surface SVG
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1280" viewBox="0 0 960 1280">
  <defs>
    <radialGradient id="asphalt" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#2D3748" />
      <stop offset="100%" stop-color="#1A202C" />
    </radialGradient>
    <pattern id="noise" width="20" height="20" patternUnits="userSpaceOnUse">
      <circle cx="5" cy="5" r="1.5" fill="#4A5568" opacity="0.4"/>
      <circle cx="15" cy="15" r="1.2" fill="#718096" opacity="0.3"/>
      <circle cx="12" cy="6" r="1" fill="#2D3748" opacity="0.5"/>
    </pattern>
  </defs>
  <rect width="960" height="1280" fill="url(#asphalt)"/>
  <rect width="960" height="1280" fill="url(#noise)"/>
  <!-- Road divider stripes -->
  <line x1="480" y1="0" x2="480" y2="1280" stroke="#ECC94B" stroke-width="8" stroke-dasharray="40 30" opacity="0.6"/>
  <!-- Road pothole distress indication -->
  <ellipse cx="480" cy="850" rx="260" ry="200" fill="#171923" stroke="#E53E3E" stroke-width="4" opacity="0.85"/>
  <text x="480" y="860" font-family="monospace" font-size="28" font-weight="bold" fill="#FEB2B2" text-anchor="middle">ROAD SURFACE INSPECTION</text>
</svg>`

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
