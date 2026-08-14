const net = require('node:net');

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '0.0.0.0', port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort, maxAttempts = 50, check = canListen) {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = startPort + offset;
    if (await check(port)) return port;
  }
  throw new Error(`No available renderer port from ${startPort} to ${startPort + maxAttempts - 1}`);
}

module.exports = { canListen, findAvailablePort };
