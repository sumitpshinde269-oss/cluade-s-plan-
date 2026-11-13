'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { Map as MapIcon } from 'lucide-react'
import { LIFECYCLES, ps, type Lifecycle } from '@/lib/pitscout'
import { PotholeMap, type MapMarker } from '@/components/pitscout/PotholeMap'
import { Empty, ErrorBox, PageHeader, STATUS_COLOR, Spinner, pct } from '@/components/pitscout/ui'

interface GeoJson { features: { geometry: { coordinates: [number, number] }; properties: { id: string; lifecycle_status: Lifecycle; report_count: number; best_confidence: number } }[] }

export default function MapPage() {
  const [markers, setMarkers] = useState<MapMarker[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ps.get<GeoJson>('map/potholes')
      .then((g) => setMarkers(g.features.map((f) => ({
        id: f.properties.id, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
        color: STATUS_COLOR[f.properties.lifecycle_status], title: `Pothole ${f.properties.id.slice(0, 8)}`,
        detail: `${f.properties.lifecycle_status} · ${f.properties.report_count} report(s) · ${pct(f.properties.best_confidence)} confidence`,
        href: `/potholes/${f.properties.id}`,
      }))))
      .catch((e) => { setError(e.message); setMarkers([]) })
  }, [])

  return (
    <div className="flex flex-col gap-4 py-4">
      <PageHeader icon={MapIcon} title="Pothole map" subtitle="Only potholes with a recorded location appear here. Click a marker to inspect it." />
      {error && <ErrorBox message={error} />}
      <ul className="flex flex-wrap gap-3 text-[11px] text-slate-300" aria-label="Legend">
        {LIFECYCLES.filter((s) => s !== 'rejected').map((s) => <li key={s} className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full" style={{ background: STATUS_COLOR[s] }} /> {s}</li>)}
      </ul>
      {markers === null ? <Spinner label="Loading map data…" /> : (
        <>
          {markers.length === 0 && <Empty title="No located potholes yet">Submit a <Link href="/report" className="text-cyan-400 underline">report with a location</Link> and it will appear here.</Empty>}
          <PotholeMap height="560px" markers={markers} />
        </>
      )}
    </div>
  )
}
