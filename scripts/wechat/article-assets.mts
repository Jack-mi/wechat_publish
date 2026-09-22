import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export function localBodyImages(markdown: string) {
  const images = [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map(match => match[1])
  for (const image of images) {
    if (/^https?:\/\//.test(image)) continue
    if (!/^\.\.\/assets\/[a-zA-Z0-9_-]+\.(?:svg|png|jpe?g|webp)$/.test(image)) throw new Error(`Unsupported local body image: ${image}`)
  }
  return [...new Set(images.filter(image => image.startsWith('../assets/')))]
}

export async function bodyAssetHashes(markdown: string, directory: string) {
  const entries = await Promise.all(localBodyImages(markdown).map(async reference => [reference, createHash('sha256').update(await fs.readFile(path.join(directory, 'assets', path.basename(reference)))).digest('hex')]))
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))
}

export async function importBodyAssets(markdown: string, parentDirectory: string, directory: string, replacements: Record<string, string> = {}, allowedRoot: string) {
  for (const [name, source] of Object.entries(replacements)) {
    if (!/^[a-zA-Z0-9_-]+\.(?:svg|png|jpe?g|webp)$/.test(name) || name === 'architecture.svg') throw new Error('Use a distinct safe filename for a new body illustration.')
    if (!localBodyImages(markdown).includes(`../assets/${name}`)) throw new Error(`Unreferenced body illustration: ${name}`)
    const real = await fs.realpath(source)
    if (!real.startsWith(`${await fs.realpath(allowedRoot)}${path.sep}`)) throw new Error('Body illustration must remain inside the article project.')
    if (path.extname(real).toLowerCase() !== path.extname(name).toLowerCase()) throw new Error('Body illustration extension mismatch.')
    if (name.endsWith('.svg')) {
      const svg = await fs.readFile(real, 'utf8')
      if (!/<svg\b/.test(svg) || /<script\b|<foreignObject\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?!#)|<!ENTITY/i.test(svg)) throw new Error('Body SVG must be self-contained and passive.')
    }
  }
  for (const reference of localBodyImages(markdown)) {
    const name = path.basename(reference)
    const destination = path.join(directory, 'assets', name)
    if (name === 'architecture.svg') continue
    await fs.copyFile(replacements[name] ?? path.join(parentDirectory, 'assets', name), destination)
  }
  return bodyAssetHashes(markdown, directory)
}
