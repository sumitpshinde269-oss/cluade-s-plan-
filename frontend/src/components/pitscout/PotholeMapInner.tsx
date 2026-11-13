'use client'

import React, { useEffect } from 'react'
import Link from 'next/link'
import { MapContainer, TileLayer, CircleMarker, Circle, Popup, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'

export interface MapMarker {
  id: string
  lat: number
  lon: number
  color: string
  title: string
  detail?: string
  href?: string
}
export interface MapProps {
  markers?: MapMarker[]
  picked?: { lat: number; lon: number; accuracy_m?: number | null } | null
  onPick?: (lat: number, lon: number) => void
  height?: string
}

function Behaviour({ markers, picked, onPick }: MapProps) {
  const map = useMap()
  useMapEvents({ click: (e) => onPick?.(e.latlng.lat, e.latlng.lng) })
  useEffect(() => {
    const pts: [number, number][] = (markers ?? []).map((m) => [m.lat, m.lon])
    if (picked) pts.push([picked.lat, picked.lon])
    if (pts.length === 1) map.setView(pts[0], 17)
    else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 17 })
  }, [map, markers, picked])
  return null
}

export default function PotholeMapInner(props: MapProps) {
  const { markers = [], picked, onPick, height = '420px' } = props
  return (
    <div style={{ height }} className="overflow-hidden rounded-xl border border-white/10" role="application" aria-label="Pothole map">
      {/* No location is assumed: world view until there is something to show. */}
      <MapContainer center={[20, 0]} zoom={2} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
        <Behaviour markers={markers} picked={picked} onPick={onPick} />
        {markers.map((m) => (
          <CircleMarker key={m.id} center={[m.lat, m.lon]} radius={9} pathOptions={{ color: '#0b1220', weight: 2, fillColor: m.color, fillOpacity: 0.95 }}>
            <Popup>
              <div className="text-xs">
                <strong>{m.title}</strong>
                {m.detail && <div>{m.detail}</div>}
                {m.href && (
                  <Link href={m.href} className="font-semibold text-cyan-700 underline">
                    Open record
                  </Link>
                )}
              </div>
            </Popup>
          </CircleMarker>
        ))}
        {picked && (
          <>
            <CircleMarker center={[picked.lat, picked.lon]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: '#06b6d4', fillOpacity: 1 }} />
            {picked.accuracy_m ? <Circle center={[picked.lat, picked.lon]} radius={picked.accuracy_m} pathOptions={{ color: '#06b6d4', weight: 1, fillOpacity: 0.12 }} /> : null}
          </>
        )}
      </MapContainer>
    </div>
  )
}
