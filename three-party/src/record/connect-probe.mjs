// One TCP connect to a loopback listener, answered as one line on standard
// output. The offline check runs this file twice against a listener it
// holds on 127.0.0.1: outside the sandbox profile, where the connect must
// succeed, and under it, where the connect must fail. It connects to no
// other host.
//
// The listener sends one line of 32 hex characters. The answer is
//
//   CONNECTED <that line>   the connect succeeded and the line was heard (exit 0)
//   <an error code>         the connect failed, for example EPERM or
//                           ECONNREFUSED (exit 1)
//   TIMEOUT, CLOSED or UNEXPECTED   no line of that shape was heard (exit 1)
//
// A wrong argument ends it with exit 2 and no answer.

import net from 'node:net';

const [host, port] = process.argv.slice(2);
if ((host !== '127.0.0.1' && host !== '::1') || !/^\d{1,5}$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535) {
  process.stderr.write('connect-probe: give 127.0.0.1 or ::1, then a port from 1 to 65535\n');
  process.exit(2);
}

let answered = false;
let heard = '';
const socket = net.connect({ host, port: Number(port) });
function answer(line, exitCode) {
  if (answered) return;
  answered = true;
  socket.destroy();
  process.exitCode = exitCode;
  process.stdout.write(`${line}\n`);
}
socket.setEncoding('latin1');
socket.setTimeout(5000, () => answer('TIMEOUT', 1));
socket.on('data', (chunk) => {
  heard += chunk;
  const end = heard.indexOf('\n');
  if (end === -1 && heard.length <= 64) return;
  const line = end === -1 ? '' : heard.slice(0, end);
  if (/^[0-9a-f]{32}$/.test(line)) answer(`CONNECTED ${line}`, 0);
  else answer('UNEXPECTED', 1);
});
socket.once('end', () => answer('CLOSED', 1));
socket.once('error', (error) => answer(/^[A-Z][A-Z0-9_]{1,31}$/.test(error.code ?? '') ? error.code : 'ERROR', 1));
