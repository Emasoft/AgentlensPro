// A server that answers with a valid status line and headers, then sends one body byte every `everyMs` and
// never finishes the body. Every byte resets a client's IDLE socket timeout, so only an overall deadline bounds
// a request to it (TRDD-V2HFI30L). close() stops the timers and destroys every open socket, so a test leaves
// nothing listening behind it.

import * as net from 'net'
import type { AddressInfo } from 'net'

export interface TrickleServer {
  port: number
  close: () => Promise<void>
}

export function startTrickleServer(everyMs = 2_000): Promise<TrickleServer> {
  const sockets = new Set<net.Socket>()
  const timers = new Set<NodeJS.Timeout>()
  const srv = net.createServer(sock => {
    sockets.add(sock)
    sock.on('error', () => { /* the client gave up — expected */ })
    sock.on('close', () => sockets.delete(sock))
    sock.once('data', () => {
      // A Content-Length far beyond what is ever sent keeps the client waiting for the rest of the body.
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n')
      const t = setInterval(() => { if (!sock.destroyed) sock.write(' ') }, everyMs)
      timers.add(t)
      sock.on('close', () => { clearInterval(t); timers.delete(t) })
    })
  })
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => resolve({
      port: (srv.address() as AddressInfo).port,
      close: () => new Promise<void>(done => {
        for (const t of timers) clearInterval(t)
        for (const s of sockets) s.destroy()
        srv.close(() => done())
      }),
    }))
  })
}
