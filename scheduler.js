var cron = require('node-cron');
var crawler = require('./crawler');
var db = require('./db');

console.log('TrendPulse Scheduler started.');
console.log('  - Weekly trend discovery: Sunday 8:07 AM');
console.log('  - Daily keyword crawl: every day 9:13 AM');

// Weekly trend discovery: Sunday at 8:07 AM
cron.schedule('7 8 * * 0', async function() {
  console.log('[Scheduler] Starting weekly trend discovery...');
  try {
    var result = await crawler.discoverTrendingTopics({ limit: 5 });
    console.log('[Scheduler] Weekly discovery complete: ' + result.totalTopics + ' topics found');
  } catch(e) {
    console.error('[Scheduler] Weekly discovery error: ' + e.message);
  }
});

// Daily keyword crawl: 9:13 AM every day
cron.schedule('13 9 * * *', async function() {
  console.log('[Scheduler] Starting daily keyword crawl...');
  try {
    var keywords = db.getUserKeywords(true).map(function(k) { return k.keyword; });
    if (keywords.length > 0) {
      await crawler.crawlAll({ keywords: keywords, count: 8, crawlType: 'keyword' });
      console.log('[Scheduler] Daily crawl complete');
    }
  } catch(e) {
    console.error('[Scheduler] Daily crawl error: ' + e.message);
  }
});

// Keep process alive
process.on('SIGINT', function() {
  console.log('\nScheduler stopped.');
  process.exit(0);
});
