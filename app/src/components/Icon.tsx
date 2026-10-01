import type { CSSProperties } from 'react'

export function Icon({
  name,
  size = 20,
  color,
  fill = false,
  style,
}: {
  name: string
  size?: number
  color?: string
  fill?: boolean
  style?: CSSProperties
}) {
  return (
    <span
      className="material-symbols-rounded"
      style={{
        fontSize: size,
        color,
        ...(fill ? { fontVariationSettings: "'FILL' 1" } : {}),
        ...style,
      }}
    >
      {name}
    </span>
  )
}
