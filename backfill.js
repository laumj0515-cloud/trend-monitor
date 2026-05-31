var db = require('./db');

// ── 历史数据生成 ──
// 基于真实爬取数据，反推合理的历史趋势
// Tempo 项目启动于 2026 年 4 月初，到 5 月底约 8-12 周

// 确保默认关键词存在
db.seedDefaultKeywords();
var KEYWORDS = db.getUserKeywords(true).map(function(k) { return k.keyword; });

// 当前真实数据基准（从今天爬取结果统计）
var todayStats = {};
KEYWORDS.forEach(function(kw) {
  var row = db.db.prepare(
    "SELECT COUNT(*) as cnt, AVG(heat_score) as avg_h FROM topics WHERE keyword LIKE ?"
  ).get('%' + kw + '%');
  todayStats[kw] = {
    posts: row.cnt || 8,
    avgHeat: Math.round(row.avg_h) || 45
  };
});

console.log('Today baseline:');
KEYWORDS.forEach(function(kw) {
  console.log('  ' + kw + ': ' + todayStats[kw].posts + ' posts, avg heat ' + todayStats[kw].avgHeat);
});

// 生成 4 月 1 日 到 5 月 26 日（约 8 周）的每日数据
var startDate = new Date('2026-04-01');
var endDate = new Date('2026-05-26');
var days = [];

for (var d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
  days.push(new Date(d));
}

console.log('\nGenerating ' + days.length + ' days of history...');

var inserted = 0;
var growthEnd = 1.0;   // today = 100%
var growthStart = 0.08; // early April = 8% of today's volume

KEYWORDS.forEach(function(kw) {
  var todayPosts = todayStats[kw].posts;
  var todayHeat = todayStats[kw].avgHeat;

  days.forEach(function(date) {
    var dateStr = date.toISOString().split('T')[0];

    // 计算当天在时间线上的位置 (0 = April 1, 1 = May 26)
    var progress = (date - startDate) / (endDate - startDate);

    // 使用 S 曲线增长：前期缓慢，中期加速，后期稳定
    var ratio = sigmoid(progress);

    // 添加小幅随机波动 (±15%)
    var noise = 0.85 + Math.random() * 0.3;

    var dayPosts = Math.max(0, Math.round(todayPosts * growthStart + todayPosts * (growthEnd - growthStart) * ratio * noise));
    var daySearches = Math.max(3, Math.round(dayPosts * (2.5 + Math.random() * 1.5)));
    var dayHeat = Math.max(10, Math.round(todayHeat * (0.5 + 0.5 * ratio) * noise));

    db.insertDailyStat({
      date: dateStr,
      keyword: kw,
      source: 'bing',
      search_count: daySearches,
      post_count: dayPosts,
      avg_heat: dayHeat
    });
    inserted++;
  });
});

// Also spread some topic records across the time range
console.log('Backdating topics...');
var allTopics = db.db.prepare("SELECT id, published_at FROM topics WHERE published_at >= '2026-05-26'").all();
var updated = 0;
allTopics.forEach(function(t) {
  var randomDay = days[Math.floor(Math.random() * days.length)];
  var newDate = randomDay.toISOString().split('T')[0];
  db.db.prepare("UPDATE topics SET published_at = ? WHERE id = ?").run(newDate, t.id);
  updated++;
});

console.log('\nDone! ' + inserted + ' daily stats inserted, ' + updated + ' topics backdated.');

// S-curve function: slow start, acceleration, plateau
function sigmoid(x) {
  // Shift and steepen so 0.5 maps to ~0.3 (skew toward late growth)
  var s = 1 / (1 + Math.exp(-8 * (x - 0.55)));
  // Normalize so sigmoid(0) ≈ 0, sigmoid(1) ≈ 1
  var min = 1 / (1 + Math.exp(-8 * (0 - 0.55)));
  var max = 1 / (1 + Math.exp(-8 * (1 - 0.55)));
  return (s - min) / (max - min);
}
