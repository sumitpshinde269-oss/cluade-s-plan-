'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Camera, Loader2, UploadCloud } from 'lucide-react'
import { msg, locationToForm, ps, type Loc, type Report } from '@/lib/pitscout'
import { LocationPicker } from '@/components/pitscout/LocationPicker'
import { ReportResult } from '@/components/pitscout/ReportResult'
import { ErrorBox, PageHeader, btnPrimary, card } from '@/components/pitscout/ui'

export default function ReportPage() {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [loc, setLoc] = useState<Loc | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<Report | null>(null)
  const idemKey = useRef<string>('')

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const onDrop = useCallback((files: File[]) => {
    if (!files[0]) return
    setFile(files[0])
    setPreview(URL.createObjectURL(files[0]))
    setReport(null)
    setError(null)
    idemKey.current = crypto.randomUUID() // one key per chosen photo: retries/double-clicks can't create duplicates
  }, [])

  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({
    onDrop,
    accept: { 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'] },
    maxSize: 50 * 1024 * 1024,
    multiple: false,
  })

  const submit = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.set('file', file)
      locationToForm(form, loc)
      setReport(await ps.upload<Report>('pothole-reports', form, { 'Idempotency-Key': idemKey.current }))
    } catch (e) {
      setError(msg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 py-4">
      <PageHeader icon={Camera} title="Report a pothole" subtitle="Upload a road photo and where it was taken. PitScout detects potholes and links repeat reports of the same pothole to one record." />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <div
            {...getRootProps()}
            className={`flex min-h-[220px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center transition ${isDragActive ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/15 bg-[#111C2E]/60 hover:border-cyan-500/40'}`}
          >
            <input {...getInputProps()} aria-label="Road photo" />
            {preview ? (
              <div className="flex flex-col items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={preview} alt="Selected road photo" className="max-h-48 rounded-lg border border-white/10 object-contain" />
                <span className="text-xs text-slate-300">{file?.name} · {Math.round((file?.size ?? 0) / 1024)} KB</span>
                <span className="text-[11px] text-cyan-400">Click or drop to replace</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <UploadCloud className="h-9 w-9 text-cyan-400" aria-hidden />
                <p className="text-sm font-bold text-white">Drop a road photo, or browse</p>
                <p className="text-xs text-slate-400">JPEG, PNG or WEBP, up to 50 MB</p>
              </div>
            )}
          </div>
          {fileRejections.length > 0 && <ErrorBox message="That file was rejected: use a JPEG, PNG or WEBP image under 50 MB." />}
        </div>

        <LocationPicker value={loc} onChange={setLoc} />
      </div>

      <div className="flex flex-col gap-3">
        <button className={`${btnPrimary} self-start`} disabled={!file || busy} onClick={submit}>
          {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Detecting and matching…</> : 'Submit report'}
        </button>
        {error && <ErrorBox message={error} />}
      </div>

      {report && <ReportResult report={report} onChange={setReport} />}
      {!report && !busy && !error && (
        <div className={`${card} text-xs text-slate-400`}>
          Results appear here: each detected pothole is shown on your photo and marked as a new pothole, a duplicate of an existing record, or needing review.
        </div>
      )}
    </div>
  )
}
