var crawler = require('./crawler');
var db = require('./db');
var notify = require('./notify');

console.log('=== TrendPulse Daily Crawl ===');
console.log(new Date().toISOString());

var keywords = db.getUserKeywords(true).map(function(k) { return k.keyword; });
console.log('Keywords: ' + keywords.length);

crawler.crawlAll({ keywords: keywords, count: 8 })
  .then(function(result) {
    console.log('Done: ' + result.totalResults + ' results');
    process.exit(0);
  })
  .catch(function(e) {
    console.error('Error: ' + e.message);
    notify.crawlFailed(e.message);
    process.exit(1);
  });
