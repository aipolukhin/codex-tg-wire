import { AppRoot } from '@telegram-apps/telegram-ui'
import { backButton, miniApp, useLaunchParams, useSignal } from '@tma.js/sdk-react'
import { useEffect, useMemo, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { loadDecision, loadDecisions } from '@/api.ts'
import { ArrowIcon, CheckIcon, ClockIcon, GridIcon, HomeIcon, LinkIcon, ReviewIcon, SearchIcon } from '@/icons.tsx'
import type { DecisionDetail, DecisionSummary, DecisionsResponse, DomainId } from '@/types.ts'

const EMPTY_RESPONSE: DecisionsResponse = {
  decisions: [],
  total: 0,
  domains: [],
  stats: { active: 0, reviewDue: 0, superseded: 0 },
}

function useBackButton(): void {
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    if (location.pathname === '/') {
      backButton.hide()
      return
    }
    backButton.show()
    const goBack = () => navigate(-1)
    backButton.onClick(goBack)
    return () => backButton.offClick(goBack)
  }, [location.pathname, navigate])
}

function Shell() {
  useBackButton()
  return <Routes>
    <Route path="/" element={<HomePage/>}/>
    <Route path="/domains" element={<DomainsPage/>}/>
    <Route path="/review" element={<ReviewPage/>}/>
    <Route path="/decisions/:id" element={<DecisionPage/>}/>
    <Route path="*" element={<Navigate to="/" replace/>}/>
  </Routes>
}

export function App() {
  const launchParams = useLaunchParams()
  const isDark = useSignal(miniApp.isDark)
  return <AppRoot
    appearance={isDark ? 'dark' : 'light'}
    platform={['ios', 'macos'].includes(launchParams.tgWebAppPlatform) ? 'ios' : 'base'}
  >
    <HashRouter><Shell/></HashRouter>
  </AppRoot>
}

function Layout({ title, children, tab = 'home' }: {
  title?: string
  children: React.ReactNode
  tab?: 'home' | 'domains' | 'review'
}) {
  const navigate = useNavigate()
  return <div className="app-shell">
    <header className="telegram-bar"><span>{title ?? 'Развилка'}</span></header>
    <main className="page">{children}</main>
    <nav className="bottom-nav" aria-label="Разделы Product Home">
      <button className={tab === 'home' ? 'active' : ''} onClick={() => navigate('/')}><HomeIcon/><span>Главная</span></button>
      <button className={tab === 'domains' ? 'active' : ''} onClick={() => navigate('/domains')}><GridIcon/><span>Домены</span></button>
      <button className={tab === 'review' ? 'active' : ''} onClick={() => navigate('/review')}><ReviewIcon/><span>Review</span></button>
    </nav>
  </div>
}

function useDecisions(input: { query?: string; domain?: string; view?: 'all' | 'active' | 'review' | 'superseded' }) {
  const [data, setData] = useState(EMPTY_RESPONSE)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    setLoading(true)
    const timeout = window.setTimeout(() => {
      void loadDecisions(input).then((response) => {
        if (!active) return
        setData(response)
        setError(null)
      }).catch((reason: unknown) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : 'Product Home недоступен.')
      }).finally(() => {
        if (active) setLoading(false)
      })
    }, input.query ? 180 : 0)
    return () => { active = false; window.clearTimeout(timeout) }
  }, [input.domain, input.query, input.view])
  return { data, error, loading }
}

function HomePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [domain, setDomain] = useState<DomainId | ''>(() => (searchParams.get('domain') ?? '') as DomainId | '')
  const request = useMemo(() => ({ query, domain: domain || undefined, view: 'all' as const }), [domain, query])
  const { data, error, loading } = useDecisions(request)
  return <Layout>
    <section className="hero">
      <p className="eyebrow">Product Home</p>
      <h1>Продуктовые решения STVOR</h1>
      <label className="search"><SearchIcon/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по решениям" aria-label="Поиск по решениям"/></label>
    </section>
    <section>
      <h2>Домены</h2>
      <div className="chips">
        <button className={domain === '' ? 'selected' : ''} onClick={() => { setDomain(''); setSearchParams({}) }}>Все</button>
        {data.domains.map((item) => <button key={item.id} className={domain === item.id ? 'selected' : ''} onClick={() => { setDomain(item.id); setSearchParams({ domain: item.id }) }}>{shortDomain(item.id)} <b>{item.count}</b></button>)}
      </div>
    </section>
    <Stats data={data}/>
    <section>
      <h2>{query || domain ? 'Найденные решения' : 'Последние решения'}</h2>
      <ResultState loading={loading} error={error} empty={data.decisions.length === 0}/>
      <div className="decision-list">{data.decisions.map((decision) => <DecisionCard key={decision.id} decision={decision}/>)}</div>
    </section>
  </Layout>
}

function DomainsPage() {
  const { data, error, loading } = useDecisions({ view: 'all' })
  const navigate = useNavigate()
  return <Layout tab="domains">
    <div className="page-heading"><p className="eyebrow">Домены</p><h1>Продуктовый канон</h1><p>Только явно принятые решения из Git.</p></div>
    <ResultState loading={loading} error={error} empty={false}/>
    <div className="domain-grid">{data.domains.map((domain) => <button key={domain.id} onClick={() => navigate(`/?domain=${domain.id}`)}>
      <span><b>{domain.title}</b><small>{domain.activeCount} действуют · {domain.reviewDueCount} review</small></span><ArrowIcon/>
    </button>)}</div>
  </Layout>
}

function ReviewPage() {
  const [view, setView] = useState<'review' | 'superseded'>('review')
  const { data, error, loading } = useDecisions({ view })
  return <Layout tab="review">
    <div className="page-heading"><p className="eyebrow">Review</p><h1>Решения для внимания</h1><p>Наступившие даты пересмотра и сохранённая история замен.</p></div>
    <div className="segmented"><button className={view === 'review' ? 'selected' : ''} onClick={() => setView('review')}>На review</button><button className={view === 'superseded' ? 'selected' : ''} onClick={() => setView('superseded')}>Заменены</button></div>
    <ResultState loading={loading} error={error} empty={data.decisions.length === 0}/>
    <div className="decision-list">{data.decisions.map((decision) => <DecisionCard key={decision.id} decision={decision}/>)}</div>
  </Layout>
}

function Stats({ data }: { data: DecisionsResponse }) {
  return <section className="stats" aria-label="Статистика решений">
    <div><span className="stat-icon blue"><CheckIcon/></span><span><small>Действуют</small><b>{data.stats.active}</b></span></div>
    <div><span className="stat-icon amber"><ClockIcon/></span><span><small>На review</small><b>{data.stats.reviewDue}</b></span></div>
  </section>
}

function DecisionCard({ decision }: { decision: DecisionSummary }) {
  const navigate = useNavigate()
  return <button className="decision-card" onClick={() => navigate(`/decisions/${decision.id}`)}>
    <span className="decision-id">{decision.id}</span>
    <strong>{decision.title}</strong>
    <span className="decision-copy">{decision.decision}</span>
    <span className="badges"><StatusBadge decision={decision}/></span>
    <span className="reason"><b>Почему:</b> {decision.reason}</span>
    {decision.originStored && <span className="origin"><LinkIcon/> Источник сохранён</span>}
  </button>
}

function StatusBadge({ decision }: { decision: DecisionSummary }) {
  if (decision.lifecycle === 'superseded') return <span className="badge gray">Заменено</span>
  if (decision.reviewDue) return <span className="badge amber">Нужен review</span>
  const implementation = {
    not_implemented: 'Не реализовано',
    partial: 'Частично',
    aligned: 'Реализовано',
    unknown: 'Реализация неизвестна',
  }[decision.implementationStatus]
  return <><span className="badge blue">Принято</span><span className={`badge ${decision.implementationStatus === 'aligned' ? 'green' : 'amber'}`}>{implementation}</span></>
}

function DecisionPage() {
  const { id = '' } = useParams()
  const [decision, setDecision] = useState<DecisionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void loadDecision(id).then((value) => { if (active) setDecision(value) }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Решение не найдено.')
    })
    return () => { active = false }
  }, [id])
  return <Layout title={decision?.id ?? 'Решение'}>
    {error && <div className="notice error">{error}</div>}
    {decision === null && error === null && <div className="notice">Загружаю решение…</div>}
    {decision && <article className="detail">
      <p className="decision-id">{decision.id} · v{decision.briefVersion}</p>
      <h1>{decision.title}</h1>
      <div className="badges"><StatusBadge decision={decision}/></div>
      <DetailSection title="Решение" text={decision.decision}/>
      <DetailSection title="Определения и границы" text={decision.definitions}/>
      <DetailSection title="Почему" text={decision.reason}/>
      <DetailSection title="Альтернативы" text={decision.alternatives}/>
      <DetailSection title="Основания и допущения" text={decision.evidence}/>
      <DetailSection title="Что затронуто" text={decision.affected.map((item) => `- ${item}`).join('\n')}/>
      <DetailSection title="Как проверим" text={decision.verification}/>
      <DetailSection title="Реализация" text={decision.implementation}/>
      <section className="provenance"><h2>Происхождение</h2><dl>
        <div><dt>Принято</dt><dd>{formatDate(decision.decidedAt)} · {decision.decidedBy}</dd></div>
        <div><dt>Версия</dt><dd>v{decision.briefVersion} · {decision.briefSha256.slice(0, 12)}…</dd></div>
        <div><dt>Telegram</dt><dd>{decision.source.telegramMessageId} → {decision.source.telegramAcceptanceMessageId}</dd></div>
        <div><dt>Codex</dt><dd>{decision.source.codexThreadId} · {decision.source.codexTurnId}</dd></div>
        <div><dt>История</dt><dd>{decision.history.join(' → ')}</dd></div>
      </dl></section>
    </article>}
  </Layout>
}

function DetailSection({ title, text }: { title: string; text: string }) {
  const lines = text.split('\n').filter(Boolean)
  const bullets = lines.every((line) => /^[-*]\s+/.test(line))
  return <section className="detail-section"><h2>{title}</h2>{bullets
    ? <ul>{lines.map((line, index) => <li key={index}>{line.replace(/^[-*]\s+/, '')}</li>)}</ul>
    : lines.map((line, index) => <p key={index}>{line}</p>)}</section>
}

function ResultState({ loading, error, empty }: { loading: boolean; error: string | null; empty: boolean }) {
  if (error) return <div className="notice error">{error}</div>
  if (loading) return <div className="notice">Загружаю решения…</div>
  if (empty) return <div className="notice">Пока нет принятых решений в этом разделе.</div>
  return null
}

function shortDomain(domain: DomainId): string {
  return { capacity: 'Capacity', commercial: 'Commercial', lifecycle: 'Lifecycle', 'customer-experience': 'CX', surfaces: 'Surfaces', legal: 'Legal' }[domain]
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value))
}
