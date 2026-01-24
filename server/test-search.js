const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:4004');

let cityId = null;

ws.on('open', () => {
  console.log('Connected');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'searchResults') {
    console.log('Content search results:');
    msg.results.slice(0, 5).forEach(r => {
      console.log('  ' + r.path + ':' + r.line + ' -> ' + (r.match || '').slice(0, 60));
    });
    console.log('Total:', msg.results.length, 'results');
    process.exit(0);
  } else if (msg.cities) {
    const city = msg.cities.find(c => c.path.includes('hexarchy-v2'));
    if (city && !cityId) {
      cityId = city.id;
      ws.send(JSON.stringify({
        type: 'searchFiles',
        cityId: cityId,
        query: 'WebSocket',
        searchId: 'test-2',
        mode: 'content'
      }));
    }
  }
});

setTimeout(() => { process.exit(1); }, 5000);
