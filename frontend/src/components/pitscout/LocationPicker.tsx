'use client'

import React, { useState } from 'react'
import { Crosshair, MapPin, X } from 'lucide-react'
import type { Loc } from '@/lib/pitscout'
import { PotholeMap } from './PotholeMap'
import { btnGhost, btnPrimary, input, Badge } from './ui'

const GEO_ERRORS: Record<number, string> = {
  1: 'Location permission was denied. You can allow it in your browser’s site settings, or enter the location manually below.',
  2: 'Your device could not determine its position. Enter the location manually, or submit without one.',
  3: 'Getting your position timed out. Try again, enter it manually, or submit without a location.',
}

export function LocationPicker({ value, onChange }: { value: Loc | null; onChange: (l: Loc | null) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const [acc, setAcc] = useState('')

  // Every change goes through commit() so the text inputs mirror the chosen location without an effect.
  const commit = (l: Loc | null) => {
    if (l) {
      setLat(l.lat.toFixed(6))
      setLon(l.lon.toFixed(6))
      setAcc(l.accuracy_m != null ? String(Math.round(l.accuracy_m)) : '')
    }
    onChange(l)
  }

  const useGps = () => {
    setError(null)
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return setError('This browser does not support geolocation. Enter the location manually.')
    }
    if (!window.isSecureContext) {
      return setError('Geolocation needs HTTPS (or localhost). Enter the location manually.')
    }
    setBusy(true)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setBusy(false)
        commit({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: p.coords.accuracy, source: 'gps' })
      },
      (e) => {
        setBusy(false)
        setError(GEO_ERRORS[e.code] ?? 'Could not get your location.')
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    )
  }

  const useManual = () => {
    const la = Number(lat), lo = Number(lon)
    if (lat.trim() === '' || lon.trim() === '' || !Number.isFinite(la) || !Number.isFinite(lo)) return setError('Latitude and longitude must be numbers.')
    if (la < -90 || la > 90) return setError('Latitude must be between -90 and 90.')
    if (lo < -180 || lo > 180) return setError('Longitude must be between -180 and 180.')
    if (la === 0 && lo === 0) return setError('(0, 0) is not accepted as a real location.')
    const a = acc.trim() === '' ? null : Number(acc)
    if (a !== null && (!Number.isFinite(a) || a < 0)) return setError('Accuracy must be a positive number of metres.')
    setError(null)
    commit({ lat: la, lon: lo, accuracy_m: a, source: 'manual' })
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-white/10 bg-slate-900/40 p-4">
      <legend className="px-1 text-xs font-bold uppercase tracking-wider text-cyan-400">Location</legend>
      <p className="text-xs text-slate-400">
        Your browser will ask permission before sharing your position. It is only attached to this report.
        Without a location the report is saved as <strong>pending location verification</strong> and is not placed on the map.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={useGps} disabled={busy} className={btnGhost}>
          <Crosshair className="h-3.5 w-3.5" /> {busy ? 'Locating…' : 'Use my current location'}
        </button>
        {value && (
          <button type="button" onClick={() => { onChange(null); setError(null) }} className={btnGhost}>
            <X className="h-3.5 w-3.5" /> Clear (submit without location)
          </button>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-[11px] text-slate-400">
          Latitude
          <input className={input} inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="e.g. 12.971600" />
        </label>
        <label className="text-[11px] text-slate-400">
          Longitude
          <input className={input} inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="e.g. 77.594600" />
        </label>
        <label className="text-[11px] text-slate-400">
          Accuracy (m, optional)
          <input className={input} inputMode="decimal" value={acc} onChange={(e) => setAcc(e.target.value)} placeholder="unknown" />
        </label>
        <div className="flex items-end">
          <button type="button" onClick={useManual} className={`${btnPrimary} w-full !py-2`}>
            <MapPin className="h-3.5 w-3.5" /> Use coordinates
          </button>
        </div>
      </div>
      <p className="text-[11px] text-slate-500">…or click the map to drop a pin.</p>

      <PotholeMap
        height="260px"
        picked={value}
        onPick={(la, lo) => commit({ lat: la, lon: lo, accuracy_m: null, source: 'manual' })}
      />

      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {value ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
          <span className="font-mono">{value.lat.toFixed(6)}, {value.lon.toFixed(6)}</span>
          <Badge className="border-white/15 bg-slate-800 text-slate-300">{value.source === 'gps' ? 'device GPS' : 'manual'}</Badge>
          <span className="text-slate-400">{value.accuracy_m != null ? `±${Math.round(value.accuracy_m)} m` : 'accuracy unknown'}</span>
        </p>
      ) : (
        <p className="text-xs text-amber-300">No location selected – the report will stay pending location verification.</p>
      )}
    </fieldset>
  )
}
