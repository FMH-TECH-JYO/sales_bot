// Extract enquiry attachments into plain text before matching.  This mirrors
// the reference project's important behaviour: office tables stay as rows so
// a local LLM sees "Range | Output | Area" rather than a scrambled document.
const PizZip = require('pizzip');
const { extractText: extractPdfText } = require('./pdfParser');

function decodeXml(value = '') {
  return value.replace(/<w:tab\/?\s*>/g, ' | ').replace(/<\/w:tc>/g, ' | ')
    .replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s*\|\s*(?:\|\s*)+/g, ' | ').replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function readZipText(zip, name) {
  const entry = zip.file(name);
  return entry ? entry.asText() : '';
}

function extractDocx(buffer) {
  const zip = new PizZip(buffer);
  return decodeXml(readZipText(zip, 'word/document.xml'));
}

function extractXlsx(buffer) {
  const zip = new PizZip(buffer);
  const shared = [];
  const sharedXml = readZipText(zip, 'xl/sharedStrings.xml');
  for (const match of sharedXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)) shared.push(decodeXml(match[1]));
  const sheetNames = [...new Set(Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)))];
  const sheets = sheetNames.map((name, index) => {
    const xml = readZipText(zip, name);
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
      const cells = [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => {
        const type = /\bt="([^"]+)"/.exec(cell[1])?.[1];
        const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] || /<is[^>]*>([\s\S]*?)<\/is>/.exec(cell[2])?.[1] || '';
        return type === 's' ? (shared[Number(value)] || '') : decodeXml(value);
      });
      return cells.join(' | ').trim();
    }).filter(Boolean);
    return rows.length ? `### Sheet ${index + 1}\n${rows.join('\n')}` : '';
  });
  return sheets.filter(Boolean).join('\n\n').trim();
}

function extractDelimited(buffer, filename) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const delimiter = filename.toLowerCase().endsWith('.tsv') ? '\t' : (text.includes('\t') ? '\t' : ',');
  return text.split(/\r?\n/).map((row) => row.split(delimiter).map((v) => v.trim()).join(' | ')).filter(Boolean).join('\n');
}

async function extractAttachment(file) {
  const name = file.originalname || 'attachment';
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (ext === '.pdf') {
    const result = await extractPdfText(file.buffer);
    return { name, type: 'pdf', text: result.text, quality: result.quality };
  }
  if (['.docx', '.docm', '.dotx'].includes(ext)) return { name, type: 'docx', text: extractDocx(file.buffer), quality: 'office_text' };
  if (['.xlsx', '.xlsm', '.xltx'].includes(ext)) return { name, type: 'excel', text: extractXlsx(file.buffer), quality: 'table' };
  if (['.csv', '.tsv'].includes(ext)) return { name, type: 'excel', text: extractDelimited(file.buffer, name), quality: 'table' };
  if (['.txt', '.md', '.text'].includes(ext)) return { name, type: 'text', text: file.buffer.toString('utf8').trim(), quality: 'clean_text' };
  // Old binary DOC/XLS needs a converter; do not silently feed binary bytes to the LLM.
  throw new Error(`${name} is an old binary Office file. Please save it as DOCX or XLSX first.`);
}

module.exports = { extractAttachment };
