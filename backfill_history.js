var db = require('./db');

var today = new Date().toISOString().split('T')[0];
var startDate = new Date('2026-04-01');
var endDate = new Date(today);
var days = [];
for (var d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) { days.push(new Date(d)); }

// Delete old modeled data
var deleted = db.db.prepare("DELETE FROM daily_stats WHERE source='bilibili_modeled'").run();
console.log('Cleared ' + deleted.changes + ' old modeled points');

// Get each keyword's latest real bilibili engagement
var keywords = db.getUserKeywords(true);
var refData = {};
keywords.forEach(function(k) {
  var row = db.db.prepare(
    "SELECT date, search_count as total_likes, post_count as videos FROM daily_stats WHERE keyword=? AND source='bilibili' ORDER BY date DESC LIMIT 1"
  ).get(k.keyword);
  if (row) {
    refData[k.keyword] = { likes: row.total_likes || 100000, videos: row.videos || 20, date: row.date };
  } else {
    refData[k.keyword] = { likes: 100000, videos: 20, date: today };
  }
});

var inserted = 0;
var skipped = 0;

keywords.forEach(function(k) {
  var kw = k.keyword;
  var ref = refData[kw];
  var currentLikes = ref.likes;
  var currentVideos = ref.videos;

  // Each keyword gets a random "history profile":
  // - baseRatio: what % of current value was the historical baseline (0.5-1.2)
  // - trend: slight upward (+0.3 to +0.5) or downward (-0.3 to -0.1)
  var seed = kw.split('').reduce(function(a,c){return a + c.charCodeAt(0)}, 0);
  var rng = function(offset) {
    var x = Math.sin(seed + offset) * 10000;
    return x - Math.floor(x);
  };
  var baseRatio = 0.5 + rng(0) * 0.7;   // 0.5 ~ 1.2  (baseline relative to current)
  var trendSlope = -0.3 + rng(1) * 0.8;  // -0.3 ~ +0.5 (downward to upward trend)
  var volatility = 0.05 + rng(2) * 0.15; // 5% ~ 20% noise

  days.forEach(function(date) {
    var dateStr = date.toISOString().split('T')[0];

    // Skip dates that already have real data
    var exists = db.db.prepare(
      "SELECT COUNT(*) as c FROM daily_stats WHERE date=? AND keyword=? AND source='bilibili'"
    ).get(dateStr, kw);
    if (exists.c > 0) { skipped++; return; }

    // Progress: 0 = April 1, 1 = today
    var totalDays = days.length;
    var dayIndex = Math.floor((date - startDate) / 86400000);
    var progress = dayIndex / totalDays;

    // Mix: baseline (baseRatio) + trend component + day-of-week noise + random noise
    var dayOfWeek = date.getDay(); // 0=Sun, 6=Sat
    var weekendEffect = (dayOfWeek === 0 || dayOfWeek === 6) ? -0.10 : 0;

    // Base value with trend
    var baseValue = currentLikes * (baseRatio + (1 - baseRatio) * progress * trendSlope);

    // Weekly cycle effect (sine wave with 7-day period)
    var weeklyWave = Math.sin(dayIndex * 2 * Math.PI / 7 + seed) * currentLikes * volatility * 0.5;

    // Random daily fluctuation
    var dailyNoise = (rng(dayIndex + 10) - 0.5) * currentLikes * volatility * 2;

    // Occasional mini-spikes (10% chance of a +15% spike)
    var spike = rng(dayIndex + 100) > 0.90 ? currentLikes * volatility * 3 : 0;

    var dayLikes = Math.round(baseValue + weeklyWave + dailyNoise + spike + (currentLikes * weekendEffect));
    dayLikes = Math.max(currentLikes * 0.1, dayLikes); // floor at 10% of current
    dayLikes = Math.min(currentLikes * 1.5, dayLikes); // cap at 150% of current

    var dayVideos = Math.round(currentVideos * (0.6 + 0.4 * progress * trendSlope + (rng(dayIndex + 50) - 0.5) * 0.3));
    dayVideos = Math.max(3, Math.min(currentVideos + 10, dayVideos));

    db.insertDailyStat({
      date: dateStr,
      keyword: kw,
      source: 'bilibili_modeled',
      search_count: dayLikes,
      post_count: dayVideos,
      avg_heat: Math.round(dayLikes / dayVideos)
    });
    inserted++;
  });
});

console.log('Done: ' + inserted + ' modeled points, skipped ' + skipped + ' real points');
