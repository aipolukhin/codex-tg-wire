import '@telegram-apps/telegram-ui/dist/styles.css'
import './styles.css'

import ReactDOM from 'react-dom/client'
import { StrictMode } from 'react'

import { App } from '@/App.tsx'
import { initTelegram } from '@/init.ts'

const root = ReactDOM.createRoot(document.getElementById('root')!)

void initTelegram().then(() => {
  root.render(<StrictMode><App/></StrictMode>)
}).catch(() => {
  root.render(<div className="standalone-error"><strong>Product Home открывается из Telegram.</strong><span>Вернись в чат с ботом и нажми кнопку Product Home.</span></div>)
})
