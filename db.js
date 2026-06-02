var Database = require('better-sqlite3');
var path = require('path');

var db = new Database(path.join(__dirname, 'data', 'trends.db'));

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    title TEXT,
    snippet TEXT,
    url TEXT,
    source TEXT,
    platform TEXT,
    likes INTEGER DEFAULT 0,
    heat_score REAL DEFAULT 0,
    published_at TEXT,
    crawled_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(url)
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    keyword TEXT NOT NULL,
    search_count INTEGER DEFAULT 0,
    post_count INTEGER DEFAULT 0,
    avg_heat REAL DEFAULT 0,
    source TEXT DEFAULT 'bing',
    UNIQUE(date, keyword, source)
  );

  CREATE TABLE IF NOT EXISTS crawl_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    keyword TEXT,
    results_count INTEGER,
    status TEXT,
    error TEXT,
    crawled_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS user_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL UNIQUE,
    added_at TEXT DEFAULT (datetime('now','localtime')),
    last_crawled TEXT,
    active INTEGER DEFAULT 1,
    category TEXT DEFAULT 'user'
  );

  CREATE TABLE IF NOT EXISTS discoveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_name TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'unknown',
    query_used TEXT,
    source_url TEXT,
    snippet TEXT,
    mention_count INTEGER DEFAULT 1,
    crawl_week TEXT,
    first_seen TEXT DEFAULT (datetime('now','localtime')),
    last_seen TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(topic_name, platform, crawl_week)
  );

  CREATE INDEX IF NOT EXISTS idx_topics_keyword ON topics(keyword);
  CREATE INDEX IF NOT EXISTS idx_topics_crawled ON topics(crawled_at);
  CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
  CREATE INDEX IF NOT EXISTS idx_daily_stats_keyword ON daily_stats(keyword);
  CREATE INDEX IF NOT EXISTS idx_discoveries_week ON discoveries(crawl_week);
  CREATE INDEX IF NOT EXISTS idx_discoveries_platform ON discoveries(platform);
`);

// Add crawl_type column if it doesn't exist (idempotent)
try { db.exec("ALTER TABLE crawl_log ADD COLUMN crawl_type TEXT DEFAULT 'keyword'"); } catch(e) {}

// ── Topic operations ──
function insertTopic(topic) {
  var stmt = db.prepare(`
    INSERT OR IGNORE INTO topics (keyword, title, snippet, url, source, platform, likes, heat_score, published_at)
    VALUES (@keyword, @title, @snippet, @url, @source, @platform, @likes, @heat_score, @published_at)
  `);
  return stmt.run(topic);
}

function insertTopics(topics) {
  var inserted = 0;
  var stmt = db.prepare(`
    INSERT OR IGNORE INTO topics (keyword, title, snippet, url, source, platform, likes, heat_score, published_at)
    VALUES (@keyword, @title, @snippet, @url, @source, @platform, @likes, @heat_score, @published_at)
  `);
  var tx = db.transaction(function(items) {
    items.forEach(function(t) {
      var r = stmt.run(t);
      if (r.changes > 0) inserted++;
    });
  });
  tx(topics);
  return inserted;
}

function getTopics(options) {
  var opts = options || {};
  var limit = opts.limit || 50;
  var offset = opts.offset || 0;
  var keyword = opts.keyword || '';
  var source = opts.source || '';
  var platform = opts.platform || '';

  var sql = 'SELECT * FROM topics WHERE 1=1';
  var params = {};

  if (keyword) {
    sql += ' AND keyword LIKE @keyword';
    params.keyword = '%' + keyword + '%';
  }
  if (source) {
    sql += ' AND source = @source';
    params.source = source;
  }
  if (platform) {
    sql += ' AND platform = @platform';
    params.platform = platform;
  }

  sql += ' ORDER BY heat_score DESC, crawled_at DESC LIMIT @limit OFFSET @offset';
  params.limit = limit;
  params.offset = offset;

  return db.prepare(sql).all(params);
}

function getHotTopics(limit) {
  return db.prepare(`
    SELECT * FROM topics
    WHERE crawled_at >= datetime('now', '-7 days')
    ORDER BY heat_score DESC
    LIMIT ?
  `).all(limit || 20);
}

// ── Daily stats ──
function insertDailyStat(stat) {
  var stmt = db.prepare(`
    INSERT OR REPLACE INTO daily_stats (date, keyword, search_count, post_count, avg_heat, source)
    VALUES (@date, @keyword, @search_count, @post_count, @avg_heat, @source)
  `);
  return stmt.run(stat);
}

function insertDailyStats(stats) {
  var stmt = db.prepare(`
    INSERT OR REPLACE INTO daily_stats (date, keyword, search_count, post_count, avg_heat, source)
    VALUES (@date, @keyword, @search_count, @post_count, @avg_heat, @source)
  `);
  var tx = db.transaction(function(items) {
    items.forEach(function(s) { stmt.run(s); });
  });
  tx(stats);
}

function getKeywordTrend(keyword, days, source) {
  var d = days || 30;
  var s = source || '';
  var sql = 'SELECT date, keyword, SUM(search_count) as total_searches, SUM(post_count) as total_posts FROM daily_stats WHERE keyword LIKE ? AND date >= date(\'now\', \'-\' || ? || \' days\')';
  if (s) {
    sql += ' AND source = \'' + s.replace(/'/g, '\'\'') + '\'';
  }
  sql += ' GROUP BY date, keyword ORDER BY date ASC';
  return db.prepare(sql).all('%' + keyword + '%', d);
}

function getTrendSummary(days) {
  var d = days || 7;
  return db.prepare(`
    SELECT keyword, SUM(search_count) as total_searches, SUM(post_count) as total_posts,
           ROUND(AVG(avg_heat), 1) as avg_heat
    FROM daily_stats
    WHERE date >= date('now', '-' || ? || ' days')
    GROUP BY keyword
    ORDER BY total_searches DESC
    LIMIT 30
  `).all(d);
}

// ── Crawl log ──
function logCrawl(log) {
  var stmt = db.prepare(`
    INSERT INTO crawl_log (source, keyword, results_count, status, error, crawl_type)
    VALUES (@source, @keyword, @results_count, @status, @error, @crawl_type)
  `);
  return stmt.run(Object.assign({ crawl_type: 'keyword' }, log));
}

function getLastCrawl() {
  return db.prepare(`
    SELECT * FROM crawl_log WHERE status = 'ok' ORDER BY crawled_at DESC LIMIT 1
  `).get();
}

function getStats() {
  return {
    totalTopics: db.prepare('SELECT COUNT(*) as c FROM topics').get().c,
    recentTopics: db.prepare("SELECT COUNT(*) as c FROM topics WHERE crawled_at >= datetime('now', '-7 days')").get().c,
    totalCrawls: db.prepare('SELECT COUNT(*) as c FROM crawl_log').get().c,
    lastCrawl: getLastCrawl()
  };
}

// ── User keywords (dynamic keyword management) ──
function seedDefaultKeywords() {
  var defaults = [
    'ADHD 拖延', '行为激活', '任务拆解 拖延症', '注意力不集中', '执行力 提升',
    '时间管理 工具', '拖延症 自救', '手机成瘾 专注', '冲动控制', '心理健康 效率'
  ];
  var stmt = db.prepare("INSERT OR IGNORE INTO user_keywords (keyword, category) VALUES (?, 'default')");
  var tx = db.transaction(function(items) {
    items.forEach(function(k) { stmt.run(k); });
  });
  tx(defaults);
  return defaults.length;
}

function upsertUserKeyword(keyword, category) {
  return db.prepare(`
    INSERT INTO user_keywords (keyword, category, active) VALUES (?, ?, 1)
    ON CONFLICT(keyword) DO UPDATE SET active = 1, last_crawled = NULL
  `).run(keyword, category || 'user');
}

function removeUserKeyword(keyword) {
  return db.prepare("UPDATE user_keywords SET active = 0 WHERE keyword = ?").run(keyword);
}

function getUserKeywords(activeOnly) {
  var sql = 'SELECT * FROM user_keywords';
  if (activeOnly) sql += ' WHERE active = 1';
  sql += ' ORDER BY added_at DESC';
  return db.prepare(sql).all();
}

// ── Discoveries (trending topic discovery) ──
function insertDiscoveries(list) {
  var stmt = db.prepare(`
    INSERT INTO discoveries (topic_name, platform, query_used, source_url, snippet, mention_count, crawl_week)
    VALUES (@topic_name, @platform, @query_used, @source_url, @snippet, @mention_count, @crawl_week)
    ON CONFLICT(topic_name, platform, crawl_week) DO UPDATE SET
      mention_count = mention_count + 1,
      last_seen = datetime('now','localtime')
  `);
  var tx = db.transaction(function(items) {
    items.forEach(function(d) { stmt.run(d); });
  });
  tx(list);
}

function getDiscoveries(options) {
  var opts = options || {};
  var limit = opts.limit || 50;
  var offset = opts.offset || 0;
  var week = opts.week || getCurrentWeek();
  var platform = opts.platform || '';

  var sql = "SELECT * FROM discoveries WHERE crawl_week = @week";
  var params = { week: week, limit: limit, offset: offset };

  if (platform) {
    sql += ' AND platform = @platform';
    params.platform = platform;
  }
  sql += ' ORDER BY mention_count DESC LIMIT @limit OFFSET @offset';
  return db.prepare(sql).all(params);
}

function getDiscoveryStats() {
  var week = getCurrentWeek();
  return {
    totalDiscoveries: db.prepare('SELECT COUNT(*) as c FROM discoveries').get().c,
    weeklyDiscoveries: db.prepare('SELECT COUNT(*) as c FROM discoveries WHERE crawl_week = ?').get(week).c,
    platformBreakdown: db.prepare(`
      SELECT platform, COUNT(*) as count FROM discoveries
      WHERE crawl_week = ? GROUP BY platform ORDER BY count DESC
    `).all(week)
  };
}

function getWeeklyDiscoveries(week) {
  var w = week || getCurrentWeek();

  // Fetch up to 100 per platform to ensure diversity
  var platforms = ['weibo', 'bilibili', 'douyin', 'xhs', 'zhihu'];
  var allRows = [];
  platforms.forEach(function(plat) {
    var rows = db.prepare(`
      SELECT * FROM discoveries WHERE crawl_week = ? AND platform = ? ORDER BY mention_count DESC LIMIT 100
    `).all(w, plat);
    allRows = allRows.concat(rows);
  });

  var byPlatform = {};
  allRows.forEach(function(r) {
    if (!byPlatform[r.platform]) byPlatform[r.platform] = [];
    byPlatform[r.platform].push(r);
  });
  return { week: w, platforms: byPlatform, totalCount: allRows.length, items: allRows };
}

function getCurrentWeek() {
  var now = new Date();
  var start = new Date(now.getFullYear(), 0, 1);
  var weekNum = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
  return now.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
}

// Ensure default keywords exist on first load
var kwCount = db.prepare('SELECT COUNT(*) as c FROM user_keywords').get().c;
if (kwCount === 0) {
  seedDefaultKeywords();
  console.log('Seeded 10 default keywords into user_keywords');
}

module.exports = {
  insertTopic: insertTopic,
  insertTopics: insertTopics,
  getTopics: getTopics,
  getHotTopics: getHotTopics,
  insertDailyStat: insertDailyStat,
  insertDailyStats: insertDailyStats,
  getKeywordTrend: getKeywordTrend,
  getTrendSummary: getTrendSummary,
  logCrawl: logCrawl,
  getLastCrawl: getLastCrawl,
  getStats: getStats,
  // User keywords
  upsertUserKeyword: upsertUserKeyword,
  removeUserKeyword: removeUserKeyword,
  getUserKeywords: getUserKeywords,
  seedDefaultKeywords: seedDefaultKeywords,
  // Discoveries
  insertDiscoveries: insertDiscoveries,
  getDiscoveries: getDiscoveries,
  getDiscoveryStats: getDiscoveryStats,
  getWeeklyDiscoveries: getWeeklyDiscoveries,
  getCurrentWeek: getCurrentWeek,
  db: db
};
