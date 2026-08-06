import { useEffect, useState, type CSSProperties } from 'react'
import {
  ArrowDown,
  ArrowUpRight,
  BrainCircuit,
  Check,
  CircleDot,
  Cloud,
  HardDrive,
  Library,
  LockKeyhole,
  Menu,
  MonitorCog,
  MousePointer2,
  Play,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { BrandMark } from '@/components/BrandMark'
import { CategoryShowcase } from '@/components/CategoryShowcase'
import { ProductStage } from '@/components/ProductStage'
import { ReleaseAction } from '@/components/ReleaseAction'
import { copy, pricingPlans, REPOSITORY_URL, RELEASES_URL, type Locale } from '@/content'
import { useRelease } from '@/hooks/useRelease'
import './App.css'

const trustIcons = [HardDrive, Cloud, ShieldCheck]
const integrationIcons = [MousePointer2, LockKeyhole, Sparkles, Library, ScanLine]

const integrationCopy = {
  en: {
    title: 'The timeline is a source contract—not a screenshot button.',
    body: 'EasyField captures the media and timing each workflow actually needs, keeps the job reviewable, then places only an approved artifact.',
    sourceTitle: 'Exact project context',
    sources: [
      ['Playhead frame', 'A source-media frame for image reference. Grade and Fusion are not baked into a regular grab.'],
      ['Visible clip trim', 'Video and audio follow the In/Out currently visible on the timeline.'],
      ['Rendered boundaries', 'Transition and Extend use rendered start/end frames from the real shot edges.'],
      ['Library or upload', 'Reuse a prior EasyField result or bring a local source when the timeline is not the right input.'],
    ],
    flow: ['Capture context', 'Privacy & cost preflight', 'Create or analyze', 'Review in Library', 'Choose placement'],
    placementTitle: 'A deliberate return to Resolve',
    placements: [
      ['Media Pool only', 'Import the approved file without touching the active timeline.'],
      ['At the playhead', 'Place on an available EasyField-managed track at the current position.'],
      ['Append to timeline', 'Add the approved artifact after the current edit when that is the intended handoff.'],
    ],
    guardrail: 'Replace Selection is disabled in the current product state. EasyField does not silently overwrite the source clip.',
  },
  he: {
    title: 'הטיימליין הוא חוזה מקור — לא כפתור לצילום מסך.',
    body: 'EasyField לוכד את המדיה והתזמון שכל תהליך באמת צריך, שומר את המשימה פתוחה לבדיקה ומציב רק תוצר שאושר.',
    sourceTitle: 'הקשר מדויק מהפרויקט',
    sources: [
      ['פריים מה־playhead', 'פריים ממדיית המקור כרפרנס לתמונה. Grab רגיל אינו אופה Grade או Fusion.'],
      ['החיתוך הנראה', 'וידאו ואודיו נשמרים לפי ה־In/Out שנראה כרגע על הטיימליין.'],
      ['גבולות מרונדרים', 'Transition ו־Extend משתמשים בפריימים מרונדרים מתחילת או מסוף השוט האמיתי.'],
      ['Library או Upload', 'משתמשים שוב בתוצאה קודמת או מביאים מקור מקומי כשהטיימליין אינו הקלט הנכון.'],
    ],
    flow: ['לכידת הקשר', 'בדיקת פרטיות ועלות', 'יצירה או ניתוח', 'בדיקה בספרייה', 'בחירת הצבה'],
    placementTitle: 'חזרה מכוונת ל־Resolve',
    placements: [
      ['Media Pool בלבד', 'מייבאים את הקובץ המאושר בלי לגעת בטיימליין הפעיל.'],
      ['בנקודת ה־playhead', 'מציבים במסלול EasyField פנוי ומנוהל במיקום הנוכחי.'],
      ['Append לטיימליין', 'מוסיפים את התוצר המאושר אחרי העריכה הקיימת כשזו ההעברה הרצויה.'],
    ],
    guardrail: 'Replace Selection מושבת במצב המוצר הנוכחי. EasyField אינו דורס את קליפ המקור בשקט.',
  },
} as const

function initialLocale(): Locale {
  const requested = new URLSearchParams(window.location.search).get('lang')
  if (requested === 'en' || requested === 'he') return requested
  const saved = window.localStorage.getItem('easyfield-site-locale')
  if (saved === 'en' || saved === 'he') return saved
  return window.navigator.language.toLowerCase().startsWith('he') ? 'he' : 'en'
}

function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState('image')
  const [billing, setBilling] = useState<'monthly' | 'annual'>('monthly')
  const release = useRelease()
  const t = copy[locale]
  const integration = integrationCopy[locale]
  const isRtl = locale === 'he'

  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = isRtl ? 'rtl' : 'ltr'
    document.title = locale === 'he'
      ? 'EasyField — פלאגין AI ל־DaVinci Resolve 21'
      : 'EasyField — AI Plugin for DaVinci Resolve 21'
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute(
      'content',
      locale === 'he'
        ? 'פלאגין AI ל־DaVinci Resolve Studio 21 עם 20 תהליכים לתמונה, וידאו, מושן ואודיו, המבוססים על ההקשר האמיתי מהטיימליין.'
        : 'AI plugin for DaVinci Resolve Studio 21 with 20 image, video, motion and audio workflows built around real timeline context.',
    )
    const structuredData = document.getElementById('easyfield-structured-data')
    if (structuredData) {
      structuredData.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Organization',
            '@id': '#organization',
            name: 'EasyField',
            sameAs: [REPOSITORY_URL],
          },
          {
            '@type': 'SoftwareApplication',
            '@id': '#software',
            name: 'EasyField',
            applicationCategory: 'MultimediaApplication',
            operatingSystem: 'macOS 15 or newer',
            softwareRequirements: 'DaVinci Resolve Studio 21.0.2 or newer',
            description: locale === 'he'
              ? 'פלאגין AI ל־DaVinci Resolve Studio 21 עם 20 תהליכים ממוקדים המבוססים על הקשר אמיתי מהטיימליין.'
              : 'AI plugin for DaVinci Resolve Studio 21 with 20 focused workflows built around real timeline context.',
            publisher: { '@id': '#organization' },
          },
          {
            '@type': 'FAQPage',
            mainEntity: copy[locale].faq.items.map((item) => ({
              '@type': 'Question',
              name: item.q,
              acceptedAnswer: { '@type': 'Answer', text: item.a },
            })),
          },
        ],
      })
    }
    window.localStorage.setItem('easyfield-site-locale', locale)
  }, [isRtl, locale])

  useEffect(() => {
    const scrollToHash = () => {
      const id = window.location.hash.slice(1)
      if (!id) return
      document.getElementById(id)?.scrollIntoView({ block: 'start' })
    }

    const timeout = window.setTimeout(scrollToHash, 180)
    window.addEventListener('hashchange', scrollToHash)
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener('hashchange', scrollToHash)
    }
  }, [])

  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      elements.forEach((element) => element.dataset.visible = 'true')
      return
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        ;(entry.target as HTMLElement).dataset.visible = 'true'
        delete (entry.target as HTMLElement).dataset.revealPending
        observer.unobserve(entry.target)
      })
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 })

    elements.forEach((element) => {
      if (element.dataset.visible !== 'true') element.dataset.revealPending = 'true'
      observer.observe(element)
    })

    const frame = window.requestAnimationFrame(() => {
      elements.forEach((element) => {
        const bounds = element.getBoundingClientRect()
        if (bounds.bottom <= 0 || bounds.top >= window.innerHeight) return
        element.dataset.visible = 'true'
        delete element.dataset.revealPending
        observer.unobserve(element)
      })
    })

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [locale])

  useEffect(() => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>('[id^="category-"]'))
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (!visible) return
      setActiveCategory((visible.target as HTMLElement).id.replace('category-', ''))
    }, { rootMargin: '-18% 0px -62% 0px', threshold: [0, .15, .35] })

    sections.forEach((section) => observer.observe(section))
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1021px)')
    const closeAtDesktop = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setMenuOpen(false)
    }
    closeAtDesktop(desktop)
    desktop.addEventListener('change', closeAtDesktop)
    return () => desktop.removeEventListener('change', closeAtDesktop)
  }, [])

  const toggleLocale = () => setLocale((current) => {
    const next = current === 'en' ? 'he' : 'en'
    const url = new URL(window.location.href)
    url.searchParams.set('lang', next)
    window.history.replaceState(window.history.state, '', url)
    return next
  })
  const closeMenu = () => setMenuOpen(false)

  return (
    <div className="site-frame">
      <a className="skip-link" href="#main">{locale === 'he' ? 'דילוג לתוכן' : 'Skip to content'}</a>

      <header className="site-header">
        <div className="site-header-inner">
          <a className="site-brand" href="#top" aria-label={locale === 'he' ? 'דף הבית של EasyField' : 'EasyField home'} onClick={closeMenu}>
            <BrandMark />
            <span className="beta-chip">BETA</span>
          </a>

          <nav className="desktop-nav" aria-label={locale === 'he' ? 'ניווט ראשי' : 'Primary navigation'}>
            <a href="#product">{t.nav.product}</a>
            <a href="#tools">{t.nav.tools}</a>
            <a href="#workflow">{t.nav.workflow}</a>
            <a href="#pricing">{t.nav.pricing}</a>
            <a href="#faq">{t.nav.faq}</a>
          </nav>

          <div className="header-actions">
            <button className="language-toggle" type="button" onClick={toggleLocale} aria-label={locale === 'he' ? 'החלפה לאנגלית' : 'Switch language to Hebrew'}>
              <span aria-hidden="true">{locale === 'en' ? 'HE' : 'EN'}</span>
              <span>{t.languageLabel}</span>
            </button>
            <ReleaseAction locale={locale} release={release} compact className="header-release" />
            <button
              className="menu-toggle"
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-controls="mobile-navigation"
              aria-label={menuOpen ? t.nav.close : t.nav.menu}
            >
              {menuOpen ? <X /> : <Menu />}
            </button>
          </div>
        </div>

        <div id="mobile-navigation" className={`mobile-nav ${menuOpen ? 'is-open' : ''}`} aria-hidden={!menuOpen} inert={!menuOpen}>
          <nav aria-label={locale === 'he' ? 'ניווט למובייל' : 'Mobile navigation'}>
            <a href="#product" onClick={closeMenu}>{t.nav.product}</a>
            <a href="#tools" onClick={closeMenu}>{t.nav.tools}</a>
            <a href="#workflow" onClick={closeMenu}>{t.nav.workflow}</a>
            <a href="#pricing" onClick={closeMenu}>{t.nav.pricing}</a>
            <a href="#faq" onClick={closeMenu}>{t.nav.faq}</a>
          </nav>
          <ReleaseAction locale={locale} release={release} />
        </div>
      </header>

      <main id="main">
        <section className="hero-section" id="top">
          <div className="hero-orbit hero-orbit-one" aria-hidden="true" />
          <div className="hero-orbit hero-orbit-two" aria-hidden="true" />

          <div className="hero-copy" data-reveal>
            <div className="eyebrow"><span className="eyebrow-dot" />{t.hero.eyebrow}</div>
            <h1>
              <span>{t.hero.titleLead}</span>
              <span className="gradient-text">{t.hero.titleAccent}</span>
            </h1>
            <p>{t.hero.body}</p>

            <div className="hero-actions">
              <ReleaseAction locale={locale} release={release} />
              <a className="secondary-action" href="#product">
                <span className="secondary-action-icon"><Play fill="currentColor" /></span>
                <span>{t.hero.secondary}</span>
                <ArrowDown aria-hidden="true" />
              </a>
            </div>

            <div className="hero-note">
              <span className={`release-live-dot ${release.status === 'available' ? 'is-live' : ''}`} />
              <span>{t.hero.note}</span>
            </div>
          </div>

          <div className="hero-stage" data-reveal>
            <ProductStage locale={locale} activeCategory={activeCategory} onCategoryChange={setActiveCategory} />
          </div>
        </section>

        <section className="proof-strip" aria-label={locale === 'he' ? 'נקודות מרכזיות במוצר' : 'Product highlights'}>
          {t.proof.map((item, index) => (
            <div className="proof-stat" key={item.label} data-reveal style={{ '--reveal-delay': `${index * 60}ms` } as CSSProperties}>
              <strong>{item.value}</strong>
              <span>{item.label}</span>
            </div>
          ))}
        </section>

        <section className="section product-section" id="product">
          <div className="section-heading product-heading" data-reveal>
            <div>
              <span className="eyebrow plain">{t.product.eyebrow}</span>
              <h2>{integration.title}</h2>
            </div>
            <div className="section-intro">
              <p>{integration.body}</p>
              <div className="label-row">
                {t.product.labels.map((label, index) => (
                  <span key={label}><Check />{label}{index === 0 && <i />}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="timeline-contract">
            <section className="timeline-contract-sources" data-reveal>
              <header>
                <span><MousePointer2 /></span>
                <div><small>01 · RESOLVE INPUT</small><h3>{integration.sourceTitle}</h3></div>
              </header>
              <div className="timeline-source-list">
                {integration.sources.map(([title, body], index) => (
                  <article key={title}>
                    <span>0{index + 1}</span>
                    <div><strong>{title}</strong><p>{body}</p></div>
                  </article>
                ))}
              </div>
            </section>

            <section className="timeline-contract-flow" data-reveal>
              <header><span>02 · EASYFIELD FLOW</span><strong>00:00:08:12</strong></header>
              <div className="contract-timeline" aria-hidden="true">
                <span className="contract-ruler"><i>00:00</i><i>00:04</i><i>00:08</i><i>00:12</i></span>
                <span className="contract-track is-video"><i /><i /><i /></span>
                <span className="contract-track is-audio"><i /><i /></span>
                <span className="contract-playhead" />
              </div>
              <div className="contract-flow-steps">
                {integration.flow.map((step, index) => {
                  const FlowIcon = integrationIcons[index]
                  return (
                    <article key={step}>
                      <span><FlowIcon /></span>
                      <small>0{index + 1}</small>
                      <strong>{step}</strong>
                      {index < integration.flow.length - 1 && <i />}
                    </article>
                  )
                })}
              </div>
            </section>

            <section className="timeline-contract-placement" data-reveal>
              <header>
                <span><Library /></span>
                <div><small>03 · REVIEWED OUTPUT</small><h3>{integration.placementTitle}</h3></div>
              </header>
              <div className="placement-options">
                {integration.placements.map(([title, body], index) => (
                  <article key={title}>
                    <span>{index === 0 ? <Library /> : index === 1 ? <ScanLine /> : <ArrowUpRight />}</span>
                    <div><strong>{title}</strong><p>{body}</p></div>
                    <Check />
                  </article>
                ))}
              </div>
              <p className="timeline-contract-guardrail"><ShieldCheck />{integration.guardrail}</p>
            </section>
          </div>
        </section>

        <CategoryShowcase locale={locale} activeCategory={activeCategory} onCategoryChange={setActiveCategory} />

        <section className="section workflow-section" id="workflow">
          <div className="section-heading workflow-heading" data-reveal>
            <div>
              <span className="eyebrow plain">{t.workflow.eyebrow}</span>
              <h2>{t.workflow.title}</h2>
            </div>
            <p>{t.workflow.body}</p>
          </div>

          <div className="workflow-track">
            <span className="workflow-line" aria-hidden="true" />
            {t.workflow.steps.map((step, index) => {
              const icons = [MousePointer2, Sparkles, ShieldCheck, Library]
              const StepIcon = icons[index]
              return (
                <article className="workflow-step" key={step.index} data-reveal style={{ '--reveal-delay': `${index * 80}ms` } as CSSProperties}>
                  <header><span>{step.index}</span><StepIcon /></header>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </article>
              )
            })}
          </div>
        </section>

        <section className="section brain-section">
          <div className="brain-shell">
            <div className="brain-copy" data-reveal>
              <div className="brain-orb"><BrainCircuit /></div>
              <span className="eyebrow plain">{t.brain.eyebrow}</span>
              <h2>{t.brain.title}</h2>
              <p>{t.brain.body}</p>
              <div className="brain-guardrail"><ShieldCheck />{t.brain.badge}</div>
            </div>

            <div className="brain-console" data-reveal>
              <header className="brain-console-head">
                <div><span className="brain-mini-orb" /><strong>SuperBrain</strong></div>
                <span><i />CONNECTED TO TIMELINE 1</span>
              </header>
              <div className="brain-thread">
                <div className="brain-message is-user">{t.brain.prompt}</div>
                <div className="brain-message is-agent">
                  <span className="agent-mark"><Sparkles /></span>
                  <p>{t.brain.response}</p>
                </div>
                <div className="brain-plan">
                  <header><span>{t.brain.status}</span><Workflow /></header>
                  {t.brain.plan.map(([number, label, mode]) => (
                    <div className="brain-plan-row" key={number}>
                      <span className="brain-plan-state">{number}</span>
                      <strong>{label}</strong>
                      <small>{mode}</small>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section trust-section">
          <div className="section-heading trust-heading" data-reveal>
            <div>
              <span className="eyebrow plain">{t.trust.eyebrow}</span>
              <h2>{t.trust.title}</h2>
            </div>
            <p>{t.trust.body}</p>
          </div>
          <div className="trust-grid">
            {t.trust.cards.map((card, index) => {
              const TrustIcon = trustIcons[index]
              return (
                <article className="trust-card" key={card.title} data-reveal style={{ '--reveal-delay': `${index * 80}ms` } as CSSProperties}>
                  <div className="trust-icon"><TrustIcon /></div>
                  <span>0{index + 1}</span>
                  <h3>{card.title}</h3>
                  <p>{card.body}</p>
                </article>
              )
            })}
          </div>
          <div className="trust-note" data-reveal><LockKeyhole />{t.trust.footnote}</div>
        </section>

        <section className="section pricing-section" id="pricing">
          <div className="pricing-head" data-reveal>
            <div>
              <span className="eyebrow plain">{t.pricing.eyebrow}</span>
              <h2>{t.pricing.title}</h2>
              <p>{t.pricing.body}</p>
            </div>
            <div className="billing-toggle" role="group" aria-label={t.pricing.billingLabel}>
              <button type="button" aria-pressed={billing === 'monthly'} className={billing === 'monthly' ? 'is-active' : ''} onClick={() => setBilling('monthly')}>{t.pricing.monthly}</button>
              <button type="button" aria-pressed={billing === 'annual'} className={billing === 'annual' ? 'is-active' : ''} onClick={() => setBilling('annual')}>{t.pricing.annual}</button>
            </div>
          </div>

          <div className="pricing-grid">
            {pricingPlans.map((plan, index) => {
              const price = billing === 'monthly' ? plan.monthly : plan.annual
              const suffix = billing === 'monthly' ? t.pricing.perMonth : t.pricing.perYear
              const monthlyEquivalent = Math.round(plan.annual / 12)
              return (
                <article className={`price-card ${plan.recommended ? 'is-recommended' : ''}`} key={plan.id} data-reveal style={{ '--reveal-delay': `${index * 60}ms` } as CSSProperties}>
                  {plan.recommended && <span className="recommended-chip"><Sparkles />{t.pricing.current}</span>}
                  <header>
                    <span className="plan-number">0{index + 1}</span>
                    <h3>{plan.name}</h3>
                  </header>
                  <div className="plan-price"><span>$</span><strong>{price.toLocaleString('en-US')}</strong><small>{suffix}</small></div>
                  {billing === 'annual' && <div className="annual-equivalent">≈ ${monthlyEquivalent} {t.pricing.perMonth}</div>}
                  <div className="plan-credits"><strong>{plan.credits}</strong><span>{t.pricing.credits}</span></div>
                  <ul>
                    <li><Check />{plan.id === 'starter' ? t.pricing.starterModels : t.pricing.allModels}</li>
                    <li><Check />{t.pricing.topup}</li>
                    <li><Check />{t.pricing.library}</li>
                  </ul>
                  <div className="plan-status"><CircleDot />{t.pricing.beta}</div>
                </article>
              )
            })}
          </div>
          <div className="partner-note" data-reveal><Sparkles />{t.pricing.partner}</div>
        </section>

        <section className="section install-section">
          <div className="install-shell">
            <div className="install-intro" data-reveal>
              <span className="eyebrow plain">{t.install.eyebrow}</span>
              <h2>{t.install.title}</h2>
              <p>{t.install.body}</p>
              <ReleaseAction locale={locale} release={release} />
            </div>

            <div className="install-content">
              <div className="install-steps">
                {t.install.steps.map((step, index) => (
                  <article className="install-step" key={step.title} data-reveal>
                    <span>0{index + 1}</span>
                    <div><h3>{step.title}</h3><p>{step.body}</p></div>
                  </article>
                ))}
              </div>
              <aside className="requirements-card" data-reveal>
                <header><MonitorCog /><span>{t.install.requirements}</span></header>
                <ul>
                  {t.install.requirementItems.map((item) => <li key={item}><Check />{item}</li>)}
                </ul>
                <p><CircleDot />{t.install.devNote}</p>
              </aside>
            </div>
          </div>
        </section>

        <section className="section faq-section" id="faq">
          <div className="faq-layout">
            <div className="faq-copy" data-reveal>
              <span className="eyebrow plain">{t.faq.eyebrow}</span>
              <h2>{t.faq.title}</h2>
              <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">GitHub <ArrowUpRight /></a>
            </div>
            <Accordion className="faq-list" type="single" collapsible defaultValue="faq-0" data-reveal>
              {t.faq.items.map((item, index) => (
                <AccordionItem className="faq-item" value={`faq-${index}`} key={item.q}>
                  <AccordionTrigger className="faq-trigger"><span className="faq-number">0{index + 1}</span><span>{item.q}</span></AccordionTrigger>
                  <AccordionContent className="faq-content">{item.a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>

        <section className="closing-section">
          <div className="closing-grid" aria-hidden="true" />
          <div className="closing-orb" aria-hidden="true"><BrandMark compact /></div>
          <div className="closing-copy" data-reveal>
            <span className="eyebrow plain">{t.closing.eyebrow}</span>
            <h2>{t.closing.title}</h2>
            <p>{t.closing.body}</p>
            <div className="closing-actions">
              <ReleaseAction locale={locale} release={release} />
              <a className="secondary-action" href={REPOSITORY_URL} target="_blank" rel="noreferrer">
                {t.closing.secondary}<ArrowUpRight />
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-brand">
          <BrandMark />
          <p>{t.footer.tagline}</p>
        </div>
        <div className="footer-links">
          <div><strong>{t.footer.product}</strong><a href="#product">{t.nav.product}</a><a href="#tools">{t.nav.tools}</a><a href="#pricing">{t.nav.pricing}</a></div>
          <div><strong>{t.footer.resources}</strong><a href={REPOSITORY_URL} target="_blank" rel="noreferrer">{t.footer.repository}</a><a href={RELEASES_URL} target="_blank" rel="noreferrer">{t.footer.releases}</a><a href={`${REPOSITORY_URL}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">{t.footer.security}</a></div>
          <div><strong>{t.footer.legal}</strong><a href="/privacy/">{t.footer.privacy}</a><a href="/terms/">{t.footer.terms}</a><a href="/refunds/">{t.footer.refunds}</a><a href={`${REPOSITORY_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">{t.footer.license}</a><a href={`${REPOSITORY_URL}/blob/main/THIRD_PARTY_NOTICES.md`} target="_blank" rel="noreferrer">{t.footer.notices}</a></div>
        </div>
        <p className="footer-trademark">{t.footer.trademark}</p>
        <div className="footer-bottom">
          <span>© 2026 {t.footer.rights}</span>
          <span className="footer-status"><i />PRIVATE BETA · v1.2.0</span>
        </div>
      </footer>
    </div>
  )
}

export default App
