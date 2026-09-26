import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export async function captureMobile(html: string, directory: string, options: { fullArticle?: boolean } = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-preview-'))
  const browser = spawn(process.env.WECHAT_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
  let socket: WebSocket | undefined
  let launchError: Error | undefined
  browser.on('error', error => { launchError = error })
  try {
    let port: number | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (launchError) throw launchError
      if (browser.exitCode !== null) throw new Error('Preview Chrome exited before becoming ready.')
      try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break } catch { await delay(100) }
    }
    assert(port, 'Preview Chrome did not start')
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>
    socket = new WebSocket(tabs.find(tab => tab.type === 'page')!.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error('Preview socket failed')) })
    let sequence = 0
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)); const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id); clearTimeout(request.timer)
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result)
    }
    const call = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 30000)
      pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }))
    })
    await call('Page.enable')
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    const targetUrl = pathToFileURL(path.resolve(html)).href
    const navigation = await call('Page.navigate', { url: targetUrl })
    assert(!navigation.errorText, navigation.errorText)
    let ready = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await call('Runtime.evaluate', { expression: `location.href === ${JSON.stringify(targetUrl)} && document.readyState === "complete" && Array.from(document.images).every(image => image.complete && image.naturalWidth > 0)`, returnByValue: true })
      if (result.result?.value) { ready = true; break }
      await delay(100)
    }
    assert(ready, 'Preview did not load completely')
    await call('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true })
    const measured = await call('Runtime.evaluate', { expression: `(() => {
      const headings = Array.from(document.querySelectorAll('h2,h3')).map(heading => {
        const lines = new Map(); const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
        while(walker.nextNode()) { const node = walker.currentNode; for(let offset=0;offset<node.textContent.length;offset+=1) { if(!node.textContent[offset].trim()) continue; const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+1);const rect=range.getBoundingClientRect();const top=Math.round(rect.top);lines.set(top,(lines.get(top)||0)+1); } }
        const counts=Array.from(lines.values());return {text:heading.textContent,lines:counts,orphan:counts.length>1&&counts[counts.length-1]===1};
      });
      return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,headings,images:Array.from(document.images).map(image=>({src:image.getAttribute('src'),width:image.getBoundingClientRect().width,height:image.getBoundingClientRect().height,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight})),ending:document.body.innerText.slice(-1600)};
    })()`, returnByValue: true })
    const metrics = measured.result.value as { width: number; scrollWidth: number; height: number; headings: Array<{ text: string; lines: number[]; orphan: boolean }>; images: unknown[]; ending: string }
    assert.equal(metrics.width, 390)
    assert(metrics.scrollWidth <= 390, 'Preview overflows the mobile viewport')
    const layout = await call('Page.getLayoutMetrics')
    const height = Math.max(844, Math.ceil(layout.cssContentSize.height))
    assert(height <= 30000, 'Preview is too tall for verified capture')
    const specs = [{ name: 'article-mobile-first.png', top: 0, height: 844 }]
    if (options.fullArticle !== false) {
      specs.push({ name: 'article-mobile-full.png', top: 0, height })
      for (let top = 0; top < height; top += 1000) specs.push({ name: `article-mobile-${top}.png`, top, height: Math.min(1100, height - top) })
    }
    await fs.mkdir(directory, { recursive: true })
    const files: string[] = []
    for (const spec of specs) {
      const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: spec.top, width: 390, height: spec.height, scale: 1 } })
      const bytes = Buffer.from(shot.data, 'base64'); assert.equal(bytes.readUInt32BE(16), 390); assert.equal(bytes.readUInt32BE(20), spec.height)
      const filename = path.join(directory, spec.name); await fs.writeFile(filename, bytes); files.push(filename)
    }
    return { files, metrics }
  } finally {
    socket?.close(); browser.kill('SIGTERM')
    await Promise.race([new Promise<void>(resolve => { if (browser.exitCode !== null || launchError) resolve(); else browser.once('exit', () => resolve()) }), delay(3000)])
    if (browser.exitCode === null && !launchError) browser.kill('SIGKILL')
    await fs.rm(profile, { recursive: true, force: true })
  }
}
