var db = require('./db');

var today = new Date().toISOString().split('T')[0];
var startDate = new Date('2026-04-01');
var endDate = new Date(today);
var days = [];
for (var d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) { days.push(new Date(d)); }

// Get each keyword's latest real bilibili engagement as the reference point
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

console.log('Reference data (latest real point):');
Object.keys(refData).forEach(function(kw) {
  console.log('  ' + kw.substring(0, 25) + ': ' + refData[kw].likes.toLocaleString() + ' likes on ' + refData[kw].date);
});

// Generate backfill: only fill dates that have NO real data
var inserted = 0;
var skipped = 0;

keywords.forEach(function(k) {
  var kw = k.keyword;
  var ref = refData[kw];
  var refDate = new Date(ref.date);
  var peakLikes = ref.likes;
  var peakVideos = ref.videos;

  days.forEach(function(date) {
    var dateStr = date.toISOString().split('T')[0];

    // Skip dates that already have real data
    var exists = db.db.prepare(
      "SELECT COUNT(*) as c FROM daily_stats WHERE date=? AND keyword=? AND source='bilibili'"
    ).get(dateStr, kw);
    if (exists.c > 0) { skipped++; return; }

    // Progress: 0 = April 1, 1 = reference date
    var totalSpan = refDate - startDate;
    var progress = totalSpan > 0 ? (date - startDate) / totalSpan : 1;
    if (progress < 0) progress = 0;
    if (progress > 1) progress = 1;

    // S-curve: slow start, accelerate, plateau
    var ratio = 1 / (1 + Math.exp(-8 * (progress - 0.55)));
    var rMin = 1 / (1 + Math.exp(-8 * (0 - 0.55)));
    var rMax = 1 / (1 + Math.exp(-8 * (1 - 0.55)));
    ratio = (ratio - rMin) / (rMax - rMin);

    // Small proportional noise (±10%)
    var noise = 0.90 + Math.random() * 0.20;

    var dayLikes = Math.max(100, Math.round(peakLikes * 0.03 + peakLikes * 0.97 * ratio * noise));
    var dayVideos = Math.max(1, Math.round(peakVideos * 0.05 + peakVideos * 0.95 * ratio * noise));

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

console.log('\nDone: ' + inserted + ' modeled points, skipped ' + skipped + ' real points.');
console.log('Modeled source = bilibili_modeled (distinct from real bilibili).');
