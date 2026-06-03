var crawler = require('./crawler');

console.log('=== TrendPulse Weekly Discovery ===');
console.log(new Date().toISOString());

crawler.discoverTrendingTopics()
  .then(function(result) {
    console.log('Done: ' + result.totalTopics + ' topics, week: ' + result.week);
    process.exit(0);
  })
  .catch(function(e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  });
