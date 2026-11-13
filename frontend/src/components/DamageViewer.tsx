'use client'

import React, { useState, useRef, useEffect } from 'react'
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Eye,
  EyeOff,
  Layers,
  SlidersHorizontal,
  Maximize2,
} from 'lucide-react'
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider'

interface BoundingBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface DetectionItem {
  detection_id: string
  class_id: number
  class_name: string
  display_name: string
  confidence: number
  bbox: BoundingBox
  measurements?: any
  severity?: any
  possible_causes?: any
  recommended_actions?: any
}

interface DamageViewerProps {
  originalImageUrl: string
  annotatedImageUrl?: string | null
  imageWidth: number
  imageHeight: number
  detections: DetectionItem[]
  selectedDetectionId?: string | null
  onSelectDetection?: (id: string | null) => void
}

const CLASS_COLORS: Record<string, { stroke: string; bg: string; text: string }> = {
  pothole: { stroke: '#EF4444', bg: 'rgba(239, 68, 68, 0.35)', text: '#FCA5A5' },
  Pothole: { stroke: '#EF4444', bg: 'rgba(239, 68, 68, 0.35)', text: '#FCA5A5' },
  manhole_cover: { stroke: '#A855F7', bg: 'rgba(168, 85, 247, 0.30)', text: '#E9D5FF' },
  Manhole: { stroke: '#A855F7', bg: 'rgba(168, 85, 247, 0.30)', text: '#E9D5FF' },
  sewage_hole: { stroke: '#E11D48', bg: 'rgba(225, 29, 72, 0.35)', text: '#FECDD3' },
  longitudinal_crack: { stroke: '#38BDF8', bg: 'rgba(56, 189, 248, 0.30)', text: '#BAE6FD' },
  'Longitudinal Crack': { stroke: '#38BDF8', bg: 'rgba(56, 189, 248, 0.30)', text: '#BAE6FD' },
  transverse_crack: { stroke: '#FACC15', bg: 'rgba(250, 204, 21, 0.30)', text: '#FEF08A' },
  'Transverse Crack': { stroke: '#FACC15', bg: 'rgba(250, 204, 21, 0.30)', text: '#FEF08A' },
  alligator_crack: { stroke: '#FB923C', bg: 'rgba(251, 146, 60, 0.30)', text: '#FED7AA' },
  'Alligator Crack': { stroke: '#FB923C', bg: 'rgba(251, 146, 60, 0.30)', text: '#FED7AA' },
  Crack: { stroke: '#38BDF8', bg: 'rgba(56, 189, 248, 0.30)', text: '#BAE6FD' },
}

export const DamageViewer: React.FC<DamageViewerProps> = ({
  originalImageUrl,
  annotatedImageUrl,
  imageWidth,
  imageHeight,
  detections,
  selectedDetectionId,
  onSelectDetection,
}) => {
  const [zoom, setZoom] = useState(1)
  const [showBoxes, setShowBoxes] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [activeTab, setActiveTab] = useState<'interactive' | 'compare'>('interactive')
  const [imgError, setImgError] = useState(false)
  const [loadedDims, setLoadedDims] = useState<{ width: number; height: number } | null>(null)
  const [visibleClasses, setVisibleClasses] = useState<Record<string, boolean>>({
    pothole: true,
    Pothole: true,
    manhole_cover: true,
    Manhole: true,
    sewage_hole: true,
    longitudinal_crack: true,
    'Longitudinal Crack': true,
    transverse_crack: true,
    'Transverse Crack': true,
    alligator_crack: true,
    'Alligator Crack': true,
    Crack: true,
  })

  useEffect(() => {
    setImgError(false)
  }, [originalImageUrl])

  const containerRef = useRef<HTMLDivElement>(null)

  const toggleClass = (className: string) => {
    setVisibleClasses((prev) => ({
      ...prev,
      [className]: !prev[className],
    }))
  }

  const handleZoomIn = () => setZoom((z) => Math.min(z + 0.25, 3))
  const handleZoomOut = () => setZoom((z) => Math.max(z - 0.25, 0.75))
  const handleResetZoom = () => setZoom(1)

  const effectiveWidth = loadedDims?.width || imageWidth || 1280
  const effectiveHeight = loadedDims?.height || imageHeight || 720

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#0E1726] p-4 shadow-xl">
      {/* Viewer Header / Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('interactive')}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === 'interactive'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Interactive Overlay
          </button>
          {annotatedImageUrl && (
            <button
              onClick={() => setActiveTab('compare')}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === 'compare'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Compare Slider
            </button>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {activeTab === 'interactive' && (
            <>
              <button
                onClick={() => setShowBoxes(!showBoxes)}
                className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                  showBoxes
                    ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                    : 'border-white/10 bg-slate-800 text-slate-400'
                }`}
                title="Toggle Bounding Boxes"
              >
                {showBoxes ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                Boxes
              </button>
              <button
                onClick={() => setShowLabels(!showLabels)}
                className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                  showLabels
                    ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                    : 'border-white/10 bg-slate-800 text-slate-400'
                }`}
                title="Toggle Labels"
              >
                Labels
              </button>
            </>
          )}

          {/* Zoom controls */}
          <div className="flex items-center gap-1 border-l border-white/10 pl-2">
            <button
              onClick={handleZoomOut}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              title="Zoom Out"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="text-xs font-mono text-slate-400 w-10 text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={handleZoomIn}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              title="Zoom In"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <button
              onClick={handleResetZoom}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              title="Reset Zoom"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Class filter tags */}
      {activeTab === 'interactive' && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-400 font-medium">Filter Classes:</span>
          {Object.keys(CLASS_COLORS).map((cls) => {
            const isVisible = visibleClasses[cls] ?? true
            const styling = CLASS_COLORS[cls]
            return (
              <button
                key={cls}
                onClick={() => toggleClass(cls)}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-medium border transition ${
                  isVisible
                    ? 'border-white/20 text-white'
                    : 'border-white/5 text-slate-500 line-through bg-slate-900/40'
                }`}
                style={{
                  backgroundColor: isVisible ? styling.bg : undefined,
                  borderColor: isVisible ? styling.stroke : undefined,
                }}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: styling.stroke }}
                />
                {cls}
              </button>
            )
          })}
        </div>
      )}

      {/* Main View Area */}
      <div
        ref={containerRef}
        className="relative overflow-auto rounded-xl border border-white/10 bg-slate-950 flex items-center justify-center min-h-[480px] max-h-[720px] p-2"
      >
        {activeTab === 'compare' && annotatedImageUrl ? (
          <div className="w-full h-full max-h-[660px] flex items-center justify-center p-2">
            <ReactCompareSlider
              itemOne={<ReactCompareSliderImage src={originalImageUrl} alt="Original Image" />}
              itemTwo={<ReactCompareSliderImage src={annotatedImageUrl} alt="Annotated Image" />}
              className="rounded-lg max-h-[620px] object-contain shadow-2xl"
            />
          </div>
        ) : (
          <div
            className="relative inline-flex items-center justify-center transition-transform duration-150 ease-out origin-center"
            style={{ transform: `scale(${zoom})` }}
          >
            {/* The Base Road Image or Interactive Road Backdrop */}
            {originalImageUrl && !imgError ? (
              <img
                src={originalImageUrl}
                alt="Road Surface Image"
                onLoad={(e) => {
                  const el = e.currentTarget
                  if (el.naturalWidth && el.naturalHeight) {
                    setLoadedDims({ width: el.naturalWidth, height: el.naturalHeight })
                  }
                }}
                onError={() => setImgError(true)}
                className="max-h-[640px] max-w-full w-auto h-auto object-contain rounded-lg select-none shadow-2xl block"
              />
            ) : (
              <div
                style={{
                  width: effectiveWidth > 0 ? Math.min(840, effectiveWidth) : 840,
                  height: effectiveHeight > 0 ? (effectiveHeight / (effectiveWidth || 1280)) * 840 : 472,
                }}
                className="relative rounded-lg bg-gradient-to-b from-[#1A2332] via-[#101723] to-[#0A0F18] border border-cyan-500/20 flex flex-col items-center justify-center overflow-hidden shadow-2xl"
              >
                {/* Simulated Road Surface Pattern */}
                <div className="absolute inset-0 opacity-25 bg-[radial-gradient(#475569_1px,transparent_1px)] [background-size:16px_16px]" />
                {/* Center road divider stripe */}
                <div className="absolute inset-y-0 left-1/2 w-1 border-r-2 border-dashed border-amber-400/50 -translate-x-1/2" />
                <span className="relative z-10 text-xs font-mono font-bold text-cyan-300 bg-slate-900/90 px-4 py-2 rounded-full border border-cyan-500/30 shadow-lg">
                  Road Surface Analysis Canvas ({effectiveWidth} &times; {effectiveHeight} px)
                </span>
              </div>
            )}

            {/* SVG Interactive Overlay */}
            {showBoxes && effectiveWidth > 0 && effectiveHeight > 0 && (
              <svg
                viewBox={`0 0 ${effectiveWidth} ${effectiveHeight}`}
                className="absolute inset-0 h-full w-full pointer-events-none drop-shadow-lg"
              >
                <defs>
                  {/* Glowing filter for high-priority pothole defects */}
                  <filter id="potholeGlow" x="-30%" y="-30%" width="160%" height="160%">
                    <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#EF4444" floodOpacity="0.95" />
                  </filter>
                  <filter id="selectGlow" x="-30%" y="-30%" width="160%" height="160%">
                    <feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#22D3EE" floodOpacity="0.95" />
                  </filter>
                  <radialGradient id="potholeHighlightGrad" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#EF4444" stopOpacity="0.45" />
                    <stop offset="70%" stopColor="#EF4444" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#EF4444" stopOpacity="0.05" />
                  </radialGradient>
                </defs>

                {detections.map((det) => {
                  const className = det.class_name || (det as any).class || 'pothole'
                  const isVisible = visibleClasses[className] ?? true
                  if (!isVisible) return null

                  const isSelected = selectedDetectionId === det.detection_id
                  const isPothole = className.toLowerCase().includes('pothole')

                  const col = CLASS_COLORS[className] || {
                    stroke: isPothole ? '#EF4444' : '#22D3EE',
                    bg: isPothole ? 'rgba(239, 68, 68, 0.35)' : 'rgba(34, 211, 238, 0.25)',
                    text: isPothole ? '#FCA5A5' : '#22D3EE',
                  }

                  // Robust coordinates extraction (handles both [x1, y1, x2, y2] and {x1, y1, x2, y2})
                  const rawBbox = det.bbox as any
                  let x1 = Array.isArray(rawBbox) ? rawBbox[0] : (rawBbox?.x1 ?? 0)
                  let y1 = Array.isArray(rawBbox) ? rawBbox[1] : (rawBbox?.y1 ?? 0)
                  let x2 = Array.isArray(rawBbox) ? rawBbox[2] : (rawBbox?.x2 ?? 0)
                  let y2 = Array.isArray(rawBbox) ? rawBbox[3] : (rawBbox?.y2 ?? 0)

                  // Scale coordinates if original natural dims differ from input imageWidth
                  if (loadedDims && imageWidth > 0 && loadedDims.width !== imageWidth) {
                    const scaleX = loadedDims.width / imageWidth
                    const scaleY = loadedDims.height / imageHeight
                    x1 *= scaleX
                    x2 *= scaleX
                    y1 *= scaleY
                    y2 *= scaleY
                  }

                  const width = Math.max(20, Math.abs(x2 - x1))
                  const height = Math.max(20, Math.abs(y2 - y1))
                  const cornerSize = Math.min(24, Math.min(width, height) / 3)
                  const centerX = x1 + width / 2
                  const centerY = y1 + height / 2

                  return (
                    <g
                      key={det.detection_id}
                      className="pointer-events-auto cursor-pointer transition-all"
                      filter={isSelected ? 'url(#selectGlow)' : (isPothole ? 'url(#potholeGlow)' : undefined)}
                    >
                      {/* Bounding box rectangle with vivid highlight */}
                      <rect
                        x={x1}
                        y={y1}
                        width={width}
                        height={height}
                        fill={isPothole ? 'url(#potholeHighlightGrad)' : (isSelected ? 'rgba(34, 211, 238, 0.25)' : col.bg)}
                        stroke={col.stroke}
                        strokeWidth={isSelected ? 4.5 : (isPothole ? 3.5 : 2.5)}
                        strokeDasharray={isSelected ? '8,4' : undefined}
                        onClick={() => onSelectDetection && onSelectDetection(det.detection_id)}
                        className="transition-all hover:stroke-cyan-300"
                        rx={6}
                      />

                      {/* Pulsing center reticle for potholes */}
                      {isPothole && (
                        <g pointerEvents="none">
                          <circle cx={centerX} cy={centerY} r={Math.min(20, width / 4)} fill="none" stroke="#EF4444" strokeWidth="2" strokeDasharray="4 2" opacity="0.8" />
                          <circle cx={centerX} cy={centerY} r="4" fill="#FFFFFF" />
                        </g>
                      )}

                      {/* High-tech Corner Accent Brackets */}
                      <g stroke="#FFFFFF" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none">
                        {/* Top-left */}
                        <path d={`M ${x1} ${y1 + cornerSize} L ${x1} ${y1} L ${x1 + cornerSize} ${y1}`} />
                        {/* Top-right */}
                        <path d={`M ${x1 + width - cornerSize} ${y1} L ${x1 + width} ${y1} L ${x1 + width} ${y1 + cornerSize}`} />
                        {/* Bottom-left */}
                        <path d={`M ${x1} ${y1 + height - cornerSize} L ${x1} ${y1} L ${x1 + cornerSize} ${y1}`} />
                        {/* Bottom-right */}
                        <path d={`M ${x1 + width - cornerSize} ${y1 + height} L ${x1 + width} ${y1 + height} L ${x1 + width} ${y1 + height - cornerSize}`} />
                      </g>

                      {/* Label badge */}
                      {showLabels && (
                        <g
                          transform={`translate(${x1}, ${Math.max(26, y1 - 10)})`}
                          onClick={() => onSelectDetection && onSelectDetection(det.detection_id)}
                        >
                          <rect
                            x={0}
                            y={-22}
                            width={Math.max(160, (className.length + 14) * 8.5)}
                            height={24}
                            fill="#0B1220"
                            stroke={col.stroke}
                            strokeWidth={2}
                            rx={5}
                          />
                          <circle cx={10} cy={-10} r={4} fill={col.stroke} />
                          <text
                            x={20}
                            y={-6}
                            fill="#FFFFFF"
                            fontSize={11.5}
                            fontFamily="monospace"
                            fontWeight="bold"
                          >
                            {className.toUpperCase()} ({Math.round(det.confidence * 100)}%)
                          </text>
                        </g>
                      )}
                    </g>
                  )
                })}
              </svg>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-slate-400 px-1 font-mono">
        <span>Image Resolution: {effectiveWidth} &times; {effectiveHeight} px</span>
        <span className="text-cyan-400 font-bold">{detections.length} defect(s) detected</span>
      </div>
    </div>
  )
}
