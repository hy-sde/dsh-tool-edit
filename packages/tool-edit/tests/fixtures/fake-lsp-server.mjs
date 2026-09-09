/**
 * A tiny fake language server speaking LSP over stdio. Used by the embedded
 * client tests to exercise framing, didOpen/didChange, formatting and
 * publishDiagnostics without downloading typescript-language-server.
 * @module dsh-tool-edit-test/fake-server
 */

/**
 * Frame reader over stdin.
 */
function createFramer(onMessage) {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const sep = buffer.indexOf('\r\n\r\n')
      if (sep === -1) return
      const head = buffer.slice(0, sep)
      const match = /Content-Length:\s*(\d+)/i.exec(head)
      const bodyStart = sep + 4
      if (!match) { buffer = buffer.slice(bodyStart); continue }
      const length = Number(match[1])
      if (buffer.length < bodyStart + length) return
      const body = buffer.slice(bodyStart, bodyStart + length)
      buffer = buffer.slice(bodyStart + length)
      onMessage(JSON.parse(body))
    }
  })
}

function send(message) {
  const body = JSON.stringify(message)
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`
  process.stdout.write(header + body)
}

const documents = new Map() // uri -> { text }

createFramer((message) => {
  const { id, method, params } = message
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { capabilities: { textDocumentSync: 1 } } })
    return
  }
  if (method === 'initialized') return
  if (method === 'shutdown') {
    send({ jsonrpc: '2.0', id, result: null })
    return
  }
  if (method === 'exit') {
    process.exit(0)
  }
  if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {
    const doc = method === 'textDocument/didOpen'
      ? params.textDocument
      : { uri: params.textDocument.uri, text: params.contentChanges[0].text }
    documents.set(doc.uri, doc.text)
    // Publish one deterministic diagnostic right after the change.
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: doc.uri,
        diagnostics: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          severity: 1,
          source: 'fake',
          message: 'fake diagnostic: text starts with ' + JSON.stringify(doc.text.slice(0, 3)),
        }],
      },
    })
    return
  }
  if (method === 'textDocument/formatting') {
    const { uri } = params.textDocument
    const text = documents.get(uri) ?? ''
    // Replace the whole document with its content plus a formatting marker.
    send({
      jsonrpc: '2.0',
      id,
      result: [{
        range: { start: { line: 0, character: 0 }, end: { line: 99999, character: 99999 } },
        newText: `${text}\n// formatted`,
      }],
    })
    return
  }
  // Unknown request → null result; unknown notification → ignore.
  if (id != null) send({ jsonrpc: '2.0', id, result: null })
})
