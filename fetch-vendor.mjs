// Download three + @mediapipe/hands tarballs from the npm registry into ./_dl
import { createWriteStream, mkdirSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import https from 'node:https'

const targets = [
  { name: 'three', url: 'https://registry.npmjs.org/three/latest' },
  { name: 'hands', url: 'https://registry.npmjs.org/@mediapipe%2Fhands/latest' },
]

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'))
    const req = https.get(url, { headers: { 'user-agent': 'dsh-vendor', accept: 'application/json' }, timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); resolve(get(res.headers.location, redirects + 1)); return }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} ${url}`)); return }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let b = ''
    stream.setEncoding('utf8')
    stream.on('data', c => { b += c })
    stream.on('end', () => resolve(b))
    stream.on('error', reject)
  })
}

mkdirSync('_dl', { recursive: true })
for (const t of targets) {
  const meta = JSON.parse(await readAll(await get(t.url)))
  const out = `_dl/${t.name}-${meta.version}.tgz`
  const res = await get(meta.dist.tarball)
  await pipeline(res, createWriteStream(out))
  console.log(JSON.stringify({ name: t.name, version: meta.version, tarball: meta.dist.tarball, out }))
}
