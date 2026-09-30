// @ts-nocheck

import JSZip from 'jszip'

// ─── Office Document Text Extraction ────────────────────
// Turns OOXML documents (docx / xlsx / pptx) into plain text the model
// can read.  Pure JS (JSZip + regex over the XML parts) so it works on
// Windows and macOS without Python or LibreOffice.

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')

const textRuns = (xml: string, tag: string): string => {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  let out = ''
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out += decodeXml(m[1])
  return out
}

// Natural sort so slide10 comes after slide9
const byNumber = (a: string, b: string): number =>
  Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0)

const extractDocx = async (zip: JSZip): Promise<string> => {
  const xml = await zip.file('word/document.xml')?.async('string')
  if (!xml) throw new Error('Invalid .docx: word/document.xml missing')

  const paragraphs: string[] = []
  const body = xml.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br\/>/g, '<w:t>\n</w:t>')

  // Tables: one row per line, cells separated by " | "
  const blockRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(body))) {
    const block = m[0]
    if (block.startsWith('<w:tbl>')) {
      const rows = block.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []
      for (const row of rows) {
        const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((c) =>
          textRuns(c, 'w:t').trim()
        )
        paragraphs.push(`| ${cells.join(' | ')} |`)
      }
      paragraphs.push('')
    } else {
      const style = block.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? ''
      const text = textRuns(block, 'w:t')
      const heading = style.match(/^Heading(\d)$/i)
      paragraphs.push(heading ? `${'#'.repeat(Number(heading[1]))} ${text}` : text)
    }
  }
  return paragraphs
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const columnIndex = (ref: string): number => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

const csvCell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

const extractXlsx = async (zip: JSZip): Promise<string> => {
  const shared: string[] = []
  const sst = await zip.file('xl/sharedStrings.xml')?.async('string')
  if (sst) {
    for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) ?? []) shared.push(textRuns(si, 't'))
  }

  // Sheet names come from workbook.xml, targets from its rels
  const workbook = (await zip.file('xl/workbook.xml')?.async('string')) ?? ''
  const rels = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) ?? ''
  const targets: Record<string, string> = {}
  for (const r of rels.match(/<Relationship [^>]+>/g) ?? []) {
    const id = r.match(/Id="([^"]+)"/)?.[1]
    const target = r.match(/Target="([^"]+)"/)?.[1]
    if (id && target) targets[id] = target.replace(/^\/?(xl\/)?/, 'xl/')
  }

  const sheets = (workbook.match(/<sheet [^>]+>/g) ?? []).map((s) => ({
    name: decodeXml(s.match(/name="([^"]+)"/)?.[1] ?? 'Sheet'),
    path: targets[s.match(/r:id="([^"]+)"/)?.[1] ?? '']
  }))

  const out: string[] = []
  for (const sheet of sheets) {
    const xml = sheet.path ? await zip.file(sheet.path)?.async('string') : null
    if (!xml) continue
    out.push(`## Sheet: ${sheet.name}`)
    for (const row of xml.match(/<row[ >][\s\S]*?<\/row>/g) ?? []) {
      const values: string[] = []
      for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = c.match(/r="([A-Z]+\d+)"/)?.[1] ?? ''
        const type = c.match(/t="([^"]+)"/)?.[1]
        const raw = c.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        const formula = c.match(/<f[^>]*>([\s\S]*?)<\/f>/)?.[1]
        let value = ''
        if (type === 's' && raw !== undefined) value = shared[Number(raw)] ?? ''
        else if (type === 'inlineStr') value = textRuns(c, 't')
        else if (raw !== undefined) value = decodeXml(raw)
        if (formula) value = `${value} [=${decodeXml(formula)}]`
        values[ref ? columnIndex(ref) : values.length] = value
      }
      out.push(Array.from(values, (v) => csvCell(v ?? '')).join(','))
    }
    out.push('')
  }
  return out.join('\n').trim()
}

const extractPptx = async (zip: JSZip): Promise<string> => {
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort(byNumber)

  const out: string[] = []
  for (const [i, file] of slides.entries()) {
    const xml = await zip.file(file)!.async('string')
    const paragraphs = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [])
      .map((p) => textRuns(p, 'a:t'))
      .filter((t) => t.trim())
    out.push(`## Slide ${i + 1}`, ...paragraphs)

    const notesFile = file.replace('slides/slide', 'notesSlides/notesSlide')
    const notes = await zip.file(notesFile)?.async('string')
    if (notes) {
      const text = (notes.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [])
        .map((p) => textRuns(p, 'a:t'))
        .filter((t) => t.trim() && !/^\d+$/.test(t.trim()))
      if (text.length) out.push(`Notes: ${text.join(' ')}`)
    }
    out.push('')
  }
  return out.join('\n').trim()
}

const EXTRACTORS: Record<string, (zip: JSZip) => Promise<string>> = {
  '.docx': extractDocx,
  '.xlsx': extractXlsx,
  '.pptx': extractPptx
}

export const isExtractableDocument = (ext: string): boolean => ext in EXTRACTORS

export const extractDocumentText = async (buffer: Buffer, ext: string): Promise<string> => {
  const extractor = EXTRACTORS[ext]
  if (!extractor) throw new Error(`Unsupported document type: ${ext}`)
  return extractor(await JSZip.loadAsync(buffer))
}
