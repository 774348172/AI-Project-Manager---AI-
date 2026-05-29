const http = require('http');
const { startServer } = require('../src/server');

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          body: JSON.parse(body)
        });
      });
    });

    request.on('error', reject);
  });
}

describe('baize local hub server', () => {
  it('starts a real HTTP server and returns health status', async () => {
    const server = startServer({ host: '127.0.0.1', port: 0, bugAnalysisTickMs: 0 });

    try {
      await new Promise((resolve) => server.on('listening', resolve));
      const { port } = server.address();
      const response = await getJson(`http://127.0.0.1:${port}/health`);

      expect(response).toEqual({
        status: 200,
        body: {
          ok: true,
          service: 'baize-local-hub',
          phase: '1'
        }
      });
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });
});
