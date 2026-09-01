import {
  backButton,
  init as initSdk,
  initData,
  miniApp,
  themeParams,
  viewport,
} from '@tma.js/sdk-react'

export async function initTelegram(): Promise<void> {
  initSdk()
  backButton.mount.ifAvailable()
  initData.restore()
  if (miniApp.mount.isAvailable()) {
    themeParams.mount()
    miniApp.mount()
    themeParams.bindCssVars()
    miniApp.ready.ifAvailable()
  }
  if (viewport.mount.isAvailable()) {
    await viewport.mount({ timeout: 3_000 }).catch(() => undefined)
    viewport.bindCssVars()
    viewport.expand()
  }
}
