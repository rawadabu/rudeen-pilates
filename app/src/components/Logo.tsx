import { useState } from 'react'
import { C } from '../lib/theme'

/** RUDEEN wordmark. Two pre-coloured transparent PNGs cut from the studio's
 *  artwork: ink for light surfaces, cream for the dark admin header. Falls
 *  back to a typographic version if a file is missing, so the header never
 *  shows a broken image. */
const RATIO = 2.9463

export function Logo({
  height = 34,
  tone = 'dark',
}: {
  height?: number
  /** 'dark' = ink on a light header, 'light' = cream on the dark header */
  tone?: 'dark' | 'light'
}) {
  const [missing, setMissing] = useState(false)
  const color = tone === 'dark' ? C.ink : C.card

  if (!missing) {
    return (
      <img
        src={tone === 'dark' ? '/logo.png' : '/logo-light.png'}
        alt="Rudeen Pilates"
        onError={() => setMissing(true)}
        style={{ height, width: Math.round(height * RATIO), display: 'block' }}
      />
    )
  }

  return (
    <svg
      height={height}
      width={Math.round(height * RATIO)}
      viewBox="0 0 330 100"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Rudeen Pilates"
      style={{ display: 'block' }}
    >
      <text x="165" y="58" textAnchor="middle" className="wordmark" fontSize="56" fontWeight="300" letterSpacing="3" fill={color}>
        RUDEEN
      </text>
      <text x="165" y="88" textAnchor="middle" className="wordmark" fontSize="15" fontWeight="400" letterSpacing="7.5" fill={color}>
        PILATES
      </text>
    </svg>
  )
}
