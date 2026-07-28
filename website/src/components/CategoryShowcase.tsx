import type { CSSProperties } from 'react'
import {
  ArrowDown,
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronDown,
  CircleDot,
  Cloud,
  Film,
  Gauge,
  HardDrive,
  Image as ImageIcon,
  Layers3,
  Library,
  MousePointer2,
  Play,
  ScanLine,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Workflow,
} from 'lucide-react'
import { categoryStories, type StoryLocale, type ToolAvailability } from '@/categoryContent'

interface CategoryShowcaseProps {
  locale: StoryLocale
  activeCategory: string
  onCategoryChange: (id: string) => void
}

const categoryIcons = {
  footage: Film,
  image: ImageIcon,
  video: Play,
  motion: Layers3,
  audio: AudioLines,
}

const modeIcons = {
  local: HardDrive,
  hybrid: ShieldCheck,
  cloud: Cloud,
  review: ScanLine,
}

const labels = {
  en: {
    eyebrow: 'FIVE DEEP WORKSPACES · TWENTY FOCUSED TOOLS',
    title: 'Every category earns its place on the timeline.',
    intro: 'EasyField is not one prompt box. Each workspace understands different sources, produces a different artifact and exposes exactly what can return to Resolve.',
    nav: 'Jump to a tool category',
    source: 'What comes from Resolve',
    return: 'What comes back',
    savings: 'The handoffs you remove',
    tools: 'Tools in this workspace',
    input: 'Input',
    function: 'What it does',
    output: 'Resolve handoff',
    time: 'Where time is saved',
    limits: 'Current boundary',
    availabilityNote: 'Public availability depends on the installed build, packaged local runtimes and verified provider adapters. Review labels are intentional product boundaries—not hidden failures.',
    mode: { local: 'Local', hybrid: 'Hybrid', cloud: 'Cloud', review: 'Review' },
    availability: {
      execution: 'Execution path',
      review: 'Review only',
      adapter: 'Adapter dependent',
      runtime: 'Local runtime',
    },
    open: 'Open tool details',
    visualLabel: 'Timeline-to-result workflow graphic',
    approved: 'Approved',
    library: 'Local Library',
    timeline: 'Resolve timeline',
  },
  he: {
    eyebrow: 'חמש סביבות עמוקות · עשרים כלים ממוקדים',
    title: 'לכל קטגוריה יש תפקיד ברור על הטיימליין.',
    intro: 'EasyField אינו תיבת פרומפט אחת. כל סביבת עבודה מבינה מקורות אחרים, מייצרת תוצר אחר ומציגה בדיוק מה יכול לחזור ל־Resolve.',
    nav: 'מעבר לקטגוריית כלים',
    source: 'מה נכנס מ־Resolve',
    return: 'מה חוזר לעריכה',
    savings: 'אילו העברות ידניות נעלמות',
    tools: 'הכלים בסביבת העבודה',
    input: 'קלט',
    function: 'מה הכלי עושה',
    output: 'החזרה ל־Resolve',
    time: 'איפה נחסך זמן',
    limits: 'המגבלה הנוכחית',
    availabilityNote: 'הזמינות הציבורית תלויה בגרסה המותקנת, ב־runtimes מקומיים ארוזים ובמתאמי ספקים מאומתים. תגית Review היא גבול מוצר מכוון — לא כשל שמוסתר.',
    mode: { local: 'מקומי', hybrid: 'היברידי', cloud: 'ענן', review: 'Review' },
    availability: {
      execution: 'נתיב ביצוע',
      review: 'Review בלבד',
      adapter: 'תלוי מתאם',
      runtime: 'Runtime מקומי',
    },
    open: 'פתיחת פרטי הכלי',
    visualLabel: 'תרשים זרימה מהטיימליין לתוצאה',
    approved: 'אושר',
    library: 'הספרייה המקומית',
    timeline: 'הטיימליין ב־Resolve',
  },
} as const

function availabilityTone(availability: ToolAvailability) {
  if (availability === 'execution') return 'is-execution'
  if (availability === 'review') return 'is-review'
  if (availability === 'runtime') return 'is-runtime'
  return 'is-adapter'
}

export function CategoryShowcase({ locale, activeCategory, onCategoryChange }: CategoryShowcaseProps) {
  const t = labels[locale]

  return (
    <section className="category-showcase section" id="tools">
      <div className="category-showcase-intro" data-reveal>
        <span className="eyebrow plain">{t.eyebrow}</span>
        <div>
          <h2>{t.title}</h2>
          <p>{t.intro}</p>
        </div>
      </div>

      <nav className="category-jump" aria-label={t.nav} data-reveal>
        {categoryStories.map((category) => {
          const CategoryIcon = categoryIcons[category.id]
          const selected = category.id === activeCategory
          return (
            <a
              key={category.id}
              href={`#category-${category.id}`}
              className={selected ? 'is-active' : ''}
              style={{ '--category-color': category.color } as CSSProperties}
              onClick={() => onCategoryChange(category.id)}
            >
              <span><CategoryIcon />{category.name[locale]}</span>
              <small>{category.index}</small>
            </a>
          )
        })}
      </nav>

      <div className="category-story-list">
        {categoryStories.map((category, categoryIndex) => {
          const CategoryIcon = categoryIcons[category.id]
          return (
            <article
              className={`category-story category-story-${category.id}`}
              id={`category-${category.id}`}
              key={category.id}
              style={{ '--category-color': category.color } as CSSProperties}
            >
              <header className="category-story-heading" data-reveal>
                <div className="category-story-number">
                  <CategoryIcon />
                  <span>{category.index} / 05</span>
                </div>
                <div className="category-story-copy">
                  <span>{category.kicker[locale]}</span>
                  <h2>{category.title[locale]}</h2>
                  <p>{category.intro[locale]}</p>
                </div>
              </header>

              <div className="category-story-stage" data-reveal>
                <figure className="category-flow-graphic" aria-label={`${category.name[locale]} · ${t.visualLabel}`}>
                  <div className="category-flow-grid" aria-hidden="true" />
                  <div className="category-flow-source">
                    <span className="category-flow-node-icon"><MousePointer2 /></span>
                    <small>{t.timeline}</small>
                    <strong>{category.pipeline.source[locale]}</strong>
                    <div className="mini-timeline">
                      <span className="mini-track"><i /><i /><i /></span>
                      <span className="mini-track is-audio"><i /><i /></span>
                      <span className="mini-playhead" />
                    </div>
                  </div>

                  <div className="category-flow-connector" aria-hidden="true">
                    <span />
                    <ArrowUpRight />
                  </div>

                  <div className="category-flow-process">
                    <header><span><Sparkles />EasyField</span><i /></header>
                    <small>{category.name[locale]}</small>
                    <strong>{category.pipeline.process[locale]}</strong>
                    <div className="category-flow-tool-lines">
                      {category.tools.slice(0, 4).map((tool, index) => (
                        <span key={tool.id} style={{ '--line-width': `${92 - index * 12}%` } as CSSProperties} />
                      ))}
                    </div>
                    <div className="category-flow-progress"><i /></div>
                  </div>

                  <div className="category-flow-connector" aria-hidden="true">
                    <span />
                    <ArrowUpRight />
                  </div>

                  <div className="category-flow-result">
                    <span className="category-flow-node-icon"><Library /></span>
                    <small>{t.library}</small>
                    <strong>{category.pipeline.result[locale]}</strong>
                    <div className="result-stack">
                      <span /><span /><span className="is-approved"><Check /></span>
                    </div>
                    <em><CircleDot />{t.approved}</em>
                  </div>
                </figure>

                <div className="category-value-grid">
                  <section>
                    <header><MousePointer2 /><span>{t.source}</span></header>
                    <ul>{category.sources[locale].map((item) => <li key={item}><ArrowDown />{item}</li>)}</ul>
                  </section>
                  <section>
                    <header><Library /><span>{t.return}</span></header>
                    <ul>{category.returns[locale].map((item) => <li key={item}><Check />{item}</li>)}</ul>
                  </section>
                  <section className="is-savings">
                    <header><TimerReset /><span>{t.savings}</span></header>
                    <ul>{category.savings[locale].map((item) => <li key={item}><Gauge />{item}</li>)}</ul>
                  </section>
                </div>
              </div>

              <div className="category-tools-heading" data-reveal>
                <div>
                  <span>{String(category.tools.length).padStart(2, '0')}</span>
                  <h3>{t.tools}</h3>
                </div>
                <p>{t.availabilityNote}</p>
              </div>

              <div className="category-tool-details">
                {category.tools.map((tool, toolIndex) => {
                  const ModeIcon = modeIcons[tool.mode]
                  return (
                    <details
                      className="category-tool-card"
                      key={tool.id}
                      id={`tool-${tool.id}`}
                      open={toolIndex === 0}
                      data-reveal
                      style={{ '--reveal-delay': `${Math.min(toolIndex, 4) * 55}ms` } as CSSProperties}
                    >
                      <summary aria-label={`${t.open}: ${tool.name[locale]}`}>
                        <span className="category-tool-index">{category.index}.{toolIndex + 1}</span>
                        <span className="category-tool-title">
                          <h3>{tool.name[locale]}</h3>
                          <p>{tool.summary[locale]}</p>
                        </span>
                        <span className="category-tool-badges">
                          <span className={`availability-badge ${availabilityTone(tool.availability)}`}>
                            <CircleDot />{t.availability[tool.availability]}
                          </span>
                          <span className="mode-badge"><ModeIcon />{t.mode[tool.mode]}</span>
                        </span>
                        <span className="category-tool-chevron"><ChevronDown /></span>
                      </summary>
                      <div className="category-tool-body">
                        <div>
                          <span><MousePointer2 />{t.input}</span>
                          <p>{tool.input[locale]}</p>
                        </div>
                        <div>
                          <span><Workflow />{t.function}</span>
                          <p>{tool.action[locale]}</p>
                        </div>
                        <div>
                          <span><Library />{t.output}</span>
                          <p>{tool.output[locale]}</p>
                        </div>
                        <div className="is-time-saving">
                          <span><TimerReset />{t.time}</span>
                          <p>{tool.savings[locale]}</p>
                        </div>
                        <div className="category-tool-limit">
                          <span><ShieldCheck />{t.limits}</span>
                          <p>{tool.limitation[locale]}</p>
                        </div>
                      </div>
                    </details>
                  )
                })}
              </div>

              {categoryIndex < categoryStories.length - 1 && (
                <a
                  className="next-category-link"
                  href={`#category-${categoryStories[categoryIndex + 1].id}`}
                  onClick={() => onCategoryChange(categoryStories[categoryIndex + 1].id)}
                >
                  <span>{categoryStories[categoryIndex + 1].name[locale]}</span>
                  <ArrowDown />
                </a>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

export default CategoryShowcase
