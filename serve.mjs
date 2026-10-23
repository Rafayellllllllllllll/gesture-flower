/**
 * 极简静态服务器（零依赖）。
 * 之所以要它：摄像头 API 只在 https 或 localhost 下可用，
 * 直接双击 index.html（file://）拿不到摄像头。
 *
 *   node serve.mjs [目录] [端口]
 */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep, join } from 'node:path'

const ROOT = resolve(process.argv[2] || '.')
const PORT = Number(process.argv[3] || process.env.PORT || 8787)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.binarypb': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'

    const target = resolve(join(ROOT, pathname))
    // 目录穿越防护
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      res.writeHead(403).end('forbidden')
      return
    }

    const info = await stat(target).catch(() => null)
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + pathname)
      return
    }

    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
      // MediaPipe 的 SharedArrayBuffer 分支在跨源隔离下更快；不需要也不影响
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'credentialless',
      'cross-origin-resource-policy': 'cross-origin',
    })
    createReadStream(target).pipe(res)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('')
  console.log('  指尖生花 已启动')
  console.log('  打开浏览器访问：  http://localhost:' + PORT + '/')
  console.log('  摄像头需要 localhost 或 https，不要用 file:// 打开')
  console.log('  按 Ctrl+C 停止')
  console.log('')
})
