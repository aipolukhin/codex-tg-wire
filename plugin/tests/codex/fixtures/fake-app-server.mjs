import { createInterface } from 'node:readline'

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

reader.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        userAgent: 'fake-app-server/1',
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    })
    return
  }
  if (message.method === 'initialized') {
    send({ method: 'server/ready', params: { fake: true } })
    return
  }
  if (message.method === 'model/list') {
    send({
      id: message.id,
      result: {
        data: [
          {
            id: 'fake-model',
            model: 'fake-model',
            displayName: 'Fake Model',
            hidden: false,
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
    })
  }
})
