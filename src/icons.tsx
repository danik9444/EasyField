// Minimal line-icon set, 16×16 viewBox, stroke 1.4, round caps.
// Glyphs are primitive shape lists ported from the design prototype.

type Prim =
  | ['l', number, number, number, number]
  | ['c', number, number, number]
  | ['cf', number, number, number]
  | ['r', number, number, number, number, number]
  | ['p', string]
  | ['pf', string]

export type GlyphName =
  | 'cut'
  | 'film'
  | 'up'
  | 'mask'
  | 'lut'
  | 'img'
  | 'board'
  | 'avatar'
  | 'edit'
  | 'angles'
  | 'vid'
  | 'editv'
  | 'extend'
  | 'trans'
  | 'anim'
  | 'cap'
  | 'music'
  | 'sfx'
  | 'vo'
  | 'transcribe'
  | 'beat'
  | 'spark'
  | 'playhead'

const GLYPHS: Record<GlyphName, Prim[]> = {
  cut: [['l', 3, 4.5, 12.5, 11.5], ['l', 12.5, 4.5, 3, 11.5], ['c', 4.2, 12, 1.6], ['c', 11.8, 12, 1.6]],
  film: [['r', 2.5, 3.5, 11, 9, 1.5], ['l', 5.5, 3.5, 5.5, 12.5], ['l', 10.5, 3.5, 10.5, 12.5]],
  up: [['l', 8, 13, 8, 4.5], ['p', '4.5,8 8,4.5 11.5,8']],
  mask: [['r', 2.5, 2.5, 11, 11, 2.5], ['c', 8, 8, 3]],
  lut: [['cf', 4.2, 8, 1.7], ['cf', 8, 8, 1.7], ['cf', 11.8, 8, 1.7]],
  img: [['r', 2.5, 3, 11, 10, 1.8], ['c', 6, 6.6, 1.3], ['l', 4.2, 12.8, 13.2, 8.2]],
  board: [['r', 2.5, 3, 11, 10, 1.5], ['l', 8, 3, 8, 13], ['l', 2.5, 8, 13.5, 8]],
  avatar: [['c', 8, 5.4, 2.5], ['r', 3.6, 10.4, 8.8, 4.6, 2.3]],
  edit: [['p', '3,13 4,10 11,3 13,5 6,12']],
  angles: [['r', 3, 3, 8, 8, 1.2], ['r', 5, 5, 8, 8, 1.2]],
  vid: [['r', 2.5, 3.5, 11, 9, 2], ['p', '6.8,6 10.2,8 6.8,10']],
  editv: [['r', 2.5, 3.5, 11, 9, 2], ['l', 5.2, 12.5, 10.8, 3.5]],
  extend: [['r', 2.5, 4, 7, 8, 1.5], ['l', 11, 8, 13.8, 8], ['p', '12,5.8 14.2,8 12,10.2']],
  trans: [['r', 2.5, 4, 7.5, 8, 1.6], ['r', 6, 4, 7.5, 8, 1.6]],
  anim: [['c', 5.5, 8, 2.9], ['c', 10.5, 8, 2.9]],
  cap: [['r', 2.5, 4, 11, 8, 1.8], ['l', 4.5, 9.6, 7.8, 9.6], ['l', 9.4, 9.6, 11.5, 9.6]],
  music: [['l', 6, 12, 6, 4], ['l', 6, 4, 12, 3], ['l', 12, 3, 12, 11], ['cf', 4.7, 12, 1.6], ['cf', 10.7, 11, 1.6]],
  sfx: [['l', 3, 6.5, 3, 9.5], ['l', 6.3, 4.5, 6.3, 11.5], ['l', 9.6, 6, 9.6, 10], ['l', 13, 3.5, 13, 12.5]],
  vo: [['r', 6, 2.5, 4, 7.5, 2], ['l', 8, 11.8, 8, 13.5], ['l', 5.2, 13.5, 10.8, 13.5]],
  transcribe: [['l', 3, 5, 13, 5], ['l', 3, 8, 13, 8], ['l', 3, 11, 9, 11]],
  beat: [['l', 3.5, 9.5, 3.5, 6.5], ['l', 6.5, 12, 6.5, 4], ['l', 9.5, 10.5, 9.5, 5.5], ['l', 12.5, 11, 12.5, 5]],
  spark: [['pf', '8,1.4 9.7,6.3 14.6,8 9.7,9.7 8,14.6 6.3,9.7 1.4,8 6.3,6.3']],
  playhead: [['c', 8, 8, 5], ['l', 8, 1, 8, 3], ['l', 8, 13, 8, 15], ['l', 1, 8, 3, 8], ['l', 13, 8, 15, 8], ['cf', 8, 8, 1.3]],
}

export function Icon({
  glyph,
  color = 'currentColor',
  size = 15,
}: {
  glyph: GlyphName
  color?: string
  size?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color, display: 'block' }}
    >
      {GLYPHS[glyph].map((p, i) => {
        switch (p[0]) {
          case 'l':
            return <line key={i} x1={p[1]} y1={p[2]} x2={p[3]} y2={p[4]} />
          case 'c':
            return <circle key={i} cx={p[1]} cy={p[2]} r={p[3]} />
          case 'cf':
            return <circle key={i} cx={p[1]} cy={p[2]} r={p[3]} fill="currentColor" stroke="none" />
          case 'r':
            return <rect key={i} x={p[1]} y={p[2]} width={p[3]} height={p[4]} rx={p[5]} />
          case 'p':
            return <polygon key={i} points={p[1]} />
          case 'pf':
            return <polygon key={i} points={p[1]} fill="currentColor" stroke="none" />
        }
      })}
    </svg>
  )
}
