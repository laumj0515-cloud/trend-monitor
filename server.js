var express = require('express');
var path = require('path');
var cron = require('node-cron');
var db = require('./db');
var crawler = require('./crawler');

var app = express();
var PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.static(__dirname));

// Serve static frontend
app.use(express.static(path.join(__dirname)));

// ── API: Stats overview ──
app.get('/api/stats', function(req, res) {
  try {
    var stats = db.getStats();
    var trendSummary = db.getTrendSummary(7);
    var discStats = db.getDiscoveryStats();
    var totalSearches = 0;
    var totalPosts = 0;
    trendSummary.forEach(function(s) {
      totalSearches += s.total_searches;
      totalPosts += s.total_posts;
    });

    res.json({
      totalTopics: stats.totalTopics,
      recentTopics: stats.recentTopics,
      totalCrawls: stats.totalCrawls,
      lastCrawl: stats.lastCrawl,
      trendKeywords: trendSummary.length,
      totalSearches: totalSearches,
      totalPosts: totalPosts,
      totalDiscoveries: discStats.totalDiscoveries,
      weeklyDiscoveries: discStats.weeklyDiscoveries,
      platformBreakdown: discStats.platformBreakdown
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Hot topics ──
app.get('/api/topics/hot', function(req, res) {
  try {
    var limit = parseInt(req.query.limit) || 20;
    var platform = req.query.platform || '';
    var topics = db.getHotTopics(limit);

    if (platform) {
      topics = topics.filter(function(t) { return t.platform === platform; });
    }

    res.json(topics);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: All topics with filters ──
app.get('/api/topics', function(req, res) {
  try {
    var options = {
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0,
      keyword: req.query.keyword || '',
      source: req.query.source || '',
      platform: req.query.platform || ''
    };
    var topics = db.getTopics(options);
    res.json(topics);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Keyword trends ──
app.get('/api/trends', function(req, res) {
  try {
    var kws = db.getUserKeywords(true);
    var defaultKw = kws.length > 0 ? kws[0].keyword : 'ADHD';
    var keyword = req.query.keyword || defaultKw;
    var days = parseInt(req.query.days) || 30;
    var source = req.query.source || '';  // 'bilibili' for engagement, '' for all
    var data = db.getKeywordTrend(keyword, days, source);

    // Reformat for chart display
    var labels = [];
    var searches = [];
    var posts = [];
    var seen = {};

    data.forEach(function(row) {
      if (!seen[row.date]) {
        seen[row.date] = { searches: 0, posts: 0 };
        labels.push(row.date);
      }
      seen[row.date].searches += row.total_searches;
      seen[row.date].posts += row.total_posts;
    });

    labels.forEach(function(d) {
      searches.push(seen[d].searches);
      posts.push(seen[d].posts);
    });

    res.json({
      keyword: keyword,
      source: source,
      labels: labels,
      searches: searches,
      posts: posts
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Keyword cloud data ──
app.get('/api/keywords', function(req, res) {
  try {
    var summary = db.getTrendSummary(7);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Trigger crawl ──
app.post('/api/crawl', async function(req, res) {
  try {
    var keywords = req.body.keywords || [];
    var count = req.body.count || 10;
    var crawlType = req.body.crawlType || 'keyword';

    res.json({ status: 'started', keywords: keywords.length || db.getUserKeywords(true).length, count: count, crawlType: crawlType });

    await crawler.crawlAll({ keywords: keywords.length > 0 ? keywords : undefined, count: count, crawlType: crawlType });
  } catch (e) {
    console.error('Crawl error: ' + e.message);
  }
});

// ── API: Today's crawl health check ──
app.get('/api/crawl/today-status', function(req, res) {
  try {
    var today = new Date().toISOString().split('T')[0];
    var hasData = db.db.prepare('SELECT COUNT(*) as c FROM daily_stats WHERE date = ?').get(today);
    var lastCrawl = db.db.prepare(
      "SELECT * FROM crawl_log WHERE status='ok' ORDER BY crawled_at DESC LIMIT 1"
    ).get();
    var lastError = db.db.prepare(
      "SELECT * FROM crawl_log WHERE status='error' ORDER BY crawled_at DESC LIMIT 1"
    ).get();
    res.json({
      today: today,
      hasData: hasData.c > 0,
      recordCount: hasData.c,
      lastOkCrawl: lastCrawl ? lastCrawl.crawled_at : null,
      lastError: lastError ? { time: lastError.crawled_at, msg: lastError.error } : null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Crawl status ──
app.get('/api/crawl/status', function(req, res) {
  try {
    var last = db.getLastCrawl();
    res.json({ lastCrawl: last });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Topic sentiment distribution ──
app.get('/api/sentiment', function(req, res) {
  try {
    var topics = db.getHotTopics(100);
    var distribution = { '热门/爆款': 0, '教程/干货': 0, '讨论/争议': 0, '资讯/新闻': 0, '其他': 0 };

    var hotWords = ['爆款', '热门', '热搜', '刷屏', '疯传', '刷爆', '必看', '推荐', '排行'];
    var tutorialWords = ['教程', '干货', '方法', '技巧', '指南', '攻略', '怎么', '如何', '步骤'];
    var discussionWords = ['争议', '讨论', '热议', '网友', '评论', '回应', '质疑', '反驳'];
    var newsWords = ['发布', '官宣', '最新', '上线', '推出', '宣布', '正式', '数据', '报告'];

    topics.forEach(function(t) {
      var text = t.title + ' ' + t.snippet;
      if (hotWords.some(function(w) { return text.indexOf(w) >= 0; })) distribution['热门/爆款']++;
      else if (tutorialWords.some(function(w) { return text.indexOf(w) >= 0; })) distribution['教程/干货']++;
      else if (discussionWords.some(function(w) { return text.indexOf(w) >= 0; })) distribution['讨论/争议']++;
      else if (newsWords.some(function(w) { return text.indexOf(w) >= 0; })) distribution['资讯/新闻']++;
      else distribution['其他']++;
    });

    res.json(distribution);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Discover trending topics ──
app.get('/api/discover', function(req, res) {
  try {
    var options = {
      limit: parseInt(req.query.limit) || 50,
      platform: req.query.platform || '',
      week: req.query.week || db.getCurrentWeek()
    };
    var items = db.getDiscoveries(options);
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/discover/weekly', function(req, res) {
  try {
    var week = req.query.week || db.getCurrentWeek();
    var data = db.getWeeklyDiscoveries(week);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/discover/crawl', async function(req, res) {
  try {
    res.json({ status: 'started', message: 'Trend discovery crawl started' });
    await crawler.discoverTrendingTopics({ limit: req.body.limit || 5 });
  } catch (e) {
    console.error('Discovery crawl error: ' + e.message);
  }
});

// ── API: Dynamic keyword management ──
app.get('/api/keywords/manage', function(req, res) {
  try {
    var keywords = db.getUserKeywords(false);
    res.json(keywords);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/keywords', function(req, res) {
  try {
    var keyword = req.body.keyword;
    if (!keyword || !keyword.trim()) {
      return res.status(400).json({ error: 'Keyword is required' });
    }
    var result = db.upsertUserKeyword(keyword.trim(), req.body.category || 'user');
    res.json({ success: true, keyword: keyword.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/keywords/:keyword', function(req, res) {
  try {
    db.removeUserKeyword(req.params.keyword);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Weekly crawl ──
app.post('/api/crawl/weekly', async function(req, res) {
  try {
    var keywords = req.body.keywords || [];
    res.json({ status: 'started', week: db.getCurrentWeek() });
    await crawler.crawlWeekly({ keywords: keywords.length > 0 ? keywords : undefined });
  } catch (e) {
    console.error('Weekly crawl error: ' + e.message);
  }
});

// ── API: Platform stats ──
app.get('/api/platforms/stats', function(req, res) {
  try {
    var platforms = { xhs: 0, douyin: 0, weibo: 0, zhihu: 0, bilibili: 0, unknown: 0 };
    var discStats = db.getDiscoveryStats();
    discStats.platformBreakdown.forEach(function(p) {
      if (platforms.hasOwnProperty(p.platform)) platforms[p.platform] = p.count;
    });
    res.json(platforms);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Single topic detail ──
app.get('/api/topics/:id', function(req, res) {
  try {
    var topic = db.db.prepare('SELECT * FROM topics WHERE id = ?').get(req.params.id);
    if (!topic) return res.status(404).json({ error: 'Not found' });
    res.json(topic);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Startup: delayed catch-up (let server start first, then crawl) ──
setTimeout(async function() {
  var today = new Date().toISOString().split('T')[0];
  var hasToday = db.db.prepare('SELECT COUNT(*) as c FROM daily_stats WHERE date = ?').get(today);
  var hasWeekly = db.db.prepare('SELECT COUNT(*) as c FROM discoveries WHERE crawl_week = ?').get(db.getCurrentWeek());

  if (!hasToday || hasToday.c === 0) {
    console.log('[Startup] No data for today yet, running catch-up crawl...');
    try {
      var keywords = db.getUserKeywords(true).map(function(k) { return k.keyword; });
      if (keywords.length > 0) {
        await crawler.crawlAll({ keywords: keywords, count: 8 });
        console.log('[Startup] Catch-up crawl done');
      }
    } catch(e) { console.error('[Startup] Catch-up error:', e.message); }
  }

  if (!hasWeekly || hasWeekly.c === 0) {
    console.log('[Startup] No weekly discovery yet, running catch-up...');
    try {
      await crawler.discoverTrendingTopics();
      console.log('[Startup] Weekly discovery done');
    } catch(e) { console.error('[Startup] Weekly error:', e.message); }
  }
}, 3000);

console.log('Scheduler: Windows Task Scheduler (daily 9:13 + weekly Sun 8:07)');

// Start server
app.listen(PORT, function() {
  console.log('TrendPulse server running at http://localhost:' + PORT);
  console.log('API: http://localhost:' + PORT + '/api/stats');
});
