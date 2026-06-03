var crawler = require('./crawler');
var notify = require('./notify');

console.log('=== TrendPulse Weekly Discovery ===');
console.log(new Date().toISOString());

crawler.discoverTrendingTopics()
  .then(function(result) {
    console.log('Done: ' + result.totalTopics + ' topics, week: ' + result.week);
    process.exit(0);
  })
  .catch(function(e) {
    console.error('Error: ' + e.message);
    notify.discoveryFailed(e.message);
    process.exit(1);
  });
