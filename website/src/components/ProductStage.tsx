import {
  ArrowRight,
  Check,
  CircleDot,
  Film,
  Library,
  MousePointer2,
  ScanLine,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import type { CSSProperties } from 'react'
import { categoryStories } from '@/categoryContent'
import resolve21Edit from '@/assets/davinci-resolve-21-edit.jpg'

export interface ProductStageProps {
  locale: 'en' | 'he'
  activeCategory: string
  onCategoryChange: (id: string) => void
}

const sourceUrl = 'https://www.blackmagicdesign.com/media/images/davinci-resolve'

const copy = {
  en: {
    stageLabel: 'EasyField workflow window shown over the official DaVinci Resolve Studio 21 Edit interface',
    official: 'OFFICIAL RESOLVE 21 EDIT UI',
    context: 'Compatibility context',
    connected: 'Timeline 01 connected',
    window: 'WORKFLOW INTEGRATION WINDOW',
    selected: 'Source under playhead',
    trim: 'Visible trim',
    review: 'Review before placement',
    local: 'Local Library first',
    place: 'Media Pool or timeline',
    open: 'Open workflow',
    source: 'Official Blackmagic Design press preview',
    disclaimer: 'DaVinci Resolve 21 interface shown for compatibility context.',
    execution: 'Execution path',
    reviewOnly: 'Review only',
    dependent: 'Build dependent',
  },
  he: {
    stageLabel: 'חלון EasyField מוצג מעל ממשק Edit הרשמי של DaVinci Resolve Studio 21',
    official: 'ממשק EDIT רשמי של RESOLVE 21',
    context: 'הקשר תאימות',
    connected: 'מחובר ל־Timeline 01',
    window: 'חלון WORKFLOW INTEGRATION',
    selected: 'מקור מתחת ל־playhead',
    trim: 'החיתוך הנראה',
    review: 'בדיקה לפני הצבה',
    local: 'קודם לספרייה המקומית',
    place: 'Media Pool או טיימליין',
    open: 'פתיחת התהליך',
    source: 'תצוגת עיתונות רשמית של Blackmagic Design',
    disclaimer: 'ממשק DaVinci Resolve 21 מוצג לצורך המחשת תאימות.',
    execution: 'נתיב ביצוע',
    reviewOnly: 'Review בלבד',
    dependent: 'תלוי בגרסה',
  },
} as const

function toolStatus(locale: 'en' | 'he', availability: string) {
  const t = copy[locale]
  if (availability === 'execution') return t.execution
  if (availability === 'review') return t.reviewOnly
  return t.dependent
}

export function ProductStage({ locale, activeCategory, onCategoryChange }: ProductStageProps) {
  const t = copy[locale]
  const selectedCategory = categoryStories.find((category) => category.id === activeCategory) ?? categoryStories[1]

  return (
    <section className="stage-product stage-product-authentic" aria-label={t.stageLabel}>
      <figure className="resolve-proof-frame">
        <div className="resolve-proof-canvas">
          <img
            className="resolve-proof-image"
            src={resolve21Edit}
            alt={locale === 'he'
              ? 'ממשק Edit הרשמי של DaVinci Resolve Studio 21 עם Media Pool, שני viewers וטיימליין מרובה מסלולים'
              : 'Official DaVinci Resolve Studio 21 Edit interface with Media Pool, dual viewers and a multitrack timeline'}
          />
          <div className="resolve-proof-shade" aria-hidden="true" />

          <div className="resolve-official-badge">
            <ShieldCheck />
            <span><strong>{t.official}</strong><small>{t.context}</small></span>
          </div>

          <div className="resolve-source-callout" aria-hidden="true">
            <span><MousePointer2 /></span>
            <div><small>{t.selected}</small><strong>{t.trim} · 00:00:08:12</strong></div>
            <i />
          </div>

          <aside className="easyfield-product-window" dir={locale === 'he' ? 'rtl' : 'ltr'}>
            <header className="easyfield-window-header">
              <div className="easyfield-window-brand">
                <span><Sparkles /></span>
                <div><strong>EasyField</strong><small>{t.window}</small></div>
              </div>
              <span className="easyfield-connected"><i />{t.connected}</span>
            </header>

            <div className="easyfield-window-tabs" role="group" aria-label={locale === 'he' ? 'קטגוריית כלים' : 'Tool category'}>
              {categoryStories.map((category) => (
                <button
                  type="button"
                  key={category.id}
                  aria-pressed={category.id === selectedCategory.id}
                  className={category.id === selectedCategory.id ? 'is-active' : ''}
                  onClick={() => onCategoryChange(category.id)}
                  style={{ '--category-color': category.color } as CSSProperties}
                >
                  {category.name[locale].replace(' AI', '')}
                </button>
              ))}
            </div>

            <div className="easyfield-window-context">
              <div className="easyfield-context-icon"><Film /></div>
              <div><small>{t.selected}</small><strong>Interview_A_07.mov</strong></div>
              <span><ScanLine />{t.trim}</span>
            </div>

            <div className="easyfield-window-category" style={{ '--category-color': selectedCategory.color } as CSSProperties}>
              <header>
                <div><small>{selectedCategory.kicker[locale]}</small><h3>{selectedCategory.name[locale]}</h3></div>
                <span>{String(selectedCategory.tools.length).padStart(2, '0')}</span>
              </header>
              <div className="easyfield-window-tools">
                {selectedCategory.tools.slice(0, 4).map((tool, index) => (
                  <article key={tool.id}>
                    <span className="easyfield-tool-number">0{index + 1}</span>
                    <div><strong>{tool.name[locale]}</strong><small>{tool.summary[locale]}</small></div>
                    <em className={`is-${tool.availability}`}><CircleDot />{toolStatus(locale, tool.availability)}</em>
                    <a
                      href={`#tool-${tool.id}`}
                      aria-label={`${t.open}: ${tool.name[locale]}`}
                      onClick={() => onCategoryChange(selectedCategory.id)}
                    >
                      <ArrowRight />
                    </a>
                  </article>
                ))}
              </div>
            </div>

            <footer className="easyfield-window-handoff">
              <span><Library />{t.local}</span>
              <i><ArrowRight /></i>
              <span><Check />{t.review}</span>
              <i><ArrowRight /></i>
              <span><ScanLine />{t.place}</span>
            </footer>
          </aside>
        </div>

        <figcaption className="resolve-proof-caption">
          <span><Check />{t.disclaimer}</span>
          <a href={sourceUrl} target="_blank" rel="noreferrer">{t.source}<ArrowRight /></a>
        </figcaption>
      </figure>
    </section>
  )
}

export default ProductStage
