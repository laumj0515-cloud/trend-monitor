var axios = require('axios');
var cheerio = require('cheerio');
var db = require('./db');
var xhsCrawler = require('./xhs_puppeteer_crawler');

// ── 追踪关键词（默认种子，实际从 DB 动态读取）──
var TRACK_KEYWORDS = [
  'ADHD 拖延',
  '行为激活',
  '任务拆解 拖延症',
  '注意力不集中',
  '执行力 提升',
  '时间管理 工具',
  '拖延症 自救',
  '手机成瘾 专注',
  '冲动控制',
  '心理健康 效率'
];

function getActiveKeywords() {
  try {
    var kws = db.getUserKeywords(true);
    if (kws.length > 0) return kws.map(function(k) { return k.keyword; });
  } catch(e) {}
  return TRACK_KEYWORDS;
}

// ── HTTP client with anti-blocking headers ──
var client = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
});

// Rate limiter
function sleep(ms) {
  return new Promise(function(res) { setTimeout(res, ms); });
}

// ── Source 1: Bing Search ──
async function crawlBing(keyword, count) {
  var results = [];
  var limit = count || 10;
  var encoded = encodeURIComponent(keyword);

  try {
    var url = 'https://www.bing.com/search?q=' + encoded + '&count=' + limit + '&setlang=zh-cn';
    var resp = await client.get(url);
    var $ = cheerio.load(resp.data);

    $('li.b_algo').each(function() {
      var title = $(this).find('h2').text().trim();
      var snippet = $(this).find('.b_caption p').text().trim() || $(this).find('p').first().text().trim();
      var link = $(this).find('h2 a').attr('href') || '';

      if (title && snippet) {
        results.push({
          keyword: keyword,
          title: title.substring(0, 200),
          snippet: snippet.substring(0, 500),
          url: link,
          source: 'bing',
          platform: detectPlatform(title + snippet),
          likes: estimateEngagement(snippet),
          heat_score: calcHeat(title, snippet),
          published_at: new Date().toISOString().split('T')[0]
        });
      }
    });
  } catch (e) {
    console.error('  Bing crawl error for "' + keyword + '": ' + e.message);
    db.logCrawl({ source: 'bing', keyword: keyword, results_count: 0, status: 'error', error: e.message });
    return results;
  }

  if (results.length > 0) {
    var inserted = db.insertTopics(results);
    console.log('  Bing: "' + keyword + '" → ' + results.length + ' results, ' + inserted + ' new');
    db.logCrawl({ source: 'bing', keyword: keyword, results_count: results.length, status: 'ok', error: '' });
  }

  return results;
}

// ── Source 2: Baidu Search (complementary) ──
async function crawlBaidu(keyword, count) {
  var results = [];
  var limit = count || 10;
  var encoded = encodeURIComponent(keyword);

  try {
    var url = 'https://www.baidu.com/s?wd=' + encoded + '&rn=' + limit;
    var resp = await client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    var $ = cheerio.load(resp.data);

    $('.result').each(function() {
      var title = $(this).find('h3 a').text().trim();
      var snippet = $(this).find('.c-abstract').text().trim() || $(this).find('.content-right_8Zs40').text().trim();
      var link = $(this).find('h3 a').attr('href') || '';

      if (title && snippet) {
        results.push({
          keyword: keyword,
          title: title.substring(0, 200),
          snippet: snippet.substring(0, 500),
          url: link,
          source: 'baidu',
          platform: detectPlatform(title + snippet),
          likes: estimateEngagement(snippet),
          heat_score: calcHeat(title, snippet),
          published_at: new Date().toISOString().split('T')[0]
        });
      }
    });
  } catch (e) {
    console.error('  Baidu crawl error for "' + keyword + '": ' + e.message);
    return results;
  }

  if (results.length > 0) {
    var inserted = db.insertTopics(results);
    console.log('  Baidu: "' + keyword + '" → ' + results.length + ' results, ' + inserted + ' new');
    db.logCrawl({ source: 'baidu', keyword: keyword, results_count: results.length, status: 'ok', error: '' });
  }

  return results;
}

// ── Source 3: News/search aggregation ──
async function crawlNewsFeed(keyword) {
  var results = [];
  var encoded = encodeURIComponent(keyword);

  try {
    // Use Bing news search
    var url = 'https://www.bing.com/news/search?q=' + encoded + '&format=rss&setlang=zh-cn';
    var resp = await client.get(url);
    var $ = cheerio.load(resp.data, { xmlMode: true });

    $('item').each(function() {
      var title = $(this).find('title').text().trim();
      var snippet = $(this).find('description').text().trim();
      var link = $(this).find('link').text().trim();

      if (title) {
        results.push({
          keyword: keyword,
          title: title.substring(0, 200),
          snippet: (snippet || '').substring(0, 500),
          url: link,
          source: 'news',
          platform: detectPlatform(title),
          likes: estimateEngagement(snippet || ''),
          heat_score: calcHeat(title, snippet || ''),
          published_at: new Date().toISOString().split('T')[0]
        });
      }
    });
  } catch (e) {
    // News feed might not always return RSS; that's ok
  }

  if (results.length > 0) {
    var inserted = db.insertTopics(results);
    console.log('  News: "' + keyword + '" → ' + results.length + ' results, ' + inserted + ' new');
    db.logCrawl({ source: 'news', keyword: keyword, results_count: results.length, status: 'ok', error: '' });
  }

  return results;
}

// ── Helper functions ──

function detectPlatform(text) {
  if (/小红书|小红书笔记|xiaohongshu|redbook|red book/i.test(text)) return 'xhs';
  if (/抖音|douyin|tiktok|短视频/i.test(text)) return 'douyin';
  if (/微博|weibo/i.test(text)) return 'weibo';
  if (/知乎|zhihu/i.test(text)) return 'zhihu';
  if (/bilibili|b站|B站|b 站/i.test(text)) return 'bilibili';
  return 'unknown';
}

function estimateEngagement(text) {
  // Crude heuristic: longer, more descriptive snippets suggest more engagement
  var score = Math.min(text.length / 10, 50);
  // Look for numbers that might indicate likes/comments
  var match = text.match(/(\d[\d,.]*)\s*(赞|评论|回复|收藏|分享|播放)/);
  if (match) {
    var n = parseInt(match[1].replace(/,/g, ''));
    if (n > score) score = Math.min(n / 100, 100);
  }
  return Math.round(score);
}

function calcHeat(title, snippet) {
  var text = title + ' ' + snippet;
  var score = 30; // base

  // Longer content = more substance
  if (text.length > 200) score += 20;
  else if (text.length > 100) score += 10;

  // Keywords indicating high engagement
  var hotWords = ['爆款', '热门', '推荐', '必看', '干货', '亲测', '逆袭', '秘诀', '真相', '教程', '分享', '经验', '热搜', '刷屏', '疯传', '刷爆', '热议', '讨论'];
  hotWords.forEach(function(w) {
    if (text.indexOf(w) >= 0) score += 5;
  });

  // Engagement signals (numbers with 万/亿/赞/评论)
  if (/\d+[万億]/.test(text)) score += 8;
  if (/\d+[赞评].*\d+/.test(text)) score += 5;

  return Math.min(score, 100);
}

// ── Daily stats aggregation ──
function aggregateDailyStats() {
  var today = new Date().toISOString().split('T')[0];
  var stats = [];
  var keywords = getActiveKeywords();
  var sources = ['bing', 'baidu', 'news'];

  keywords.forEach(function(kw) {
    sources.forEach(function(src) {
      var count = db.db.prepare(
        "SELECT COUNT(*) as c FROM topics WHERE keyword LIKE ? AND source = ? AND crawled_at >= ?"
      ).get('%' + kw + '%', src, today + ' 00:00:00').c;

      var avgHeat = 0;
      if (count > 0) {
        var row = db.db.prepare(
          "SELECT AVG(heat_score) as a FROM topics WHERE keyword LIKE ? AND source = ? AND crawled_at >= ?"
        ).get('%' + kw + '%', src, today + ' 00:00:00');
        avgHeat = row ? Math.round(row.a) || 0 : 0;
      }

      stats.push({
        date: today,
        keyword: kw,
        source: src,
        search_count: count,  // real crawl count, no random
        post_count: count,
        avg_heat: avgHeat
      });
    });
  });

  db.insertDailyStats(stats);
  console.log('Daily stats aggregated: ' + stats.length + ' records');
}

// ── Main crawl function ──
async function crawlAll(options) {
  var opts = options || {};
  var keywords = opts.keywords || getActiveKeywords();
  var perSource = opts.count || 10;
  var crawlType = opts.crawlType || 'keyword';
  var totalResults = 0;

  console.log('=== TrendPulse Crawl Start ===');
  console.log('Type: ' + crawlType + ', Keywords: ' + keywords.length + ', per source: ' + perSource);
  console.log('');

  for (var i = 0; i < keywords.length; i++) {
    var kw = keywords[i];
    console.log('[' + (i + 1) + '/' + keywords.length + '] Crawling: "' + kw + '"');

    var bingResults = await crawlBing(kw, perSource);
    totalResults += bingResults.length;

    // Polite delay between keyword groups
    if ((i + 1) % 3 === 0 && i < keywords.length - 1) {
      console.log('  (waiting 2s...)');
      await sleep(2000);
    }

    var baiduResults = await crawlBaidu(kw, perSource);
    totalResults += baiduResults.length;

    await sleep(800);

    var newsResults = await crawlNewsFeed(kw);
    totalResults += newsResults.length;
  }

  // Aggregate today's stats
  aggregateDailyStats();

  console.log('');
  console.log('=== Crawl Complete: ' + totalResults + ' total results ===');

  return {
    totalResults: totalResults,
    timestamp: new Date().toISOString()
  };
}

// ── Trend discovery: fetch real hot lists from platforms ──
async function discoverTrendingTopics(options) {
  var opts = options || {};
  var totalTopics = 0;
  var week = db.getCurrentWeek();

  console.log('=== Trend Discovery Start (Real APIs) ===');
  console.log('Week: ' + week);

  // Try each platform's hot list API
  var results = await Promise.allSettled
    ? await Promise.allSettled([fetchWeiboHot(), fetchBilibiliHot(), fetchDouyinHot(), fetchXhsTopics()])
    : [];

  if (results.length === 0) {
    // Fallback for older Node: run sequentially
    var wb = await tryCatch(fetchWeiboHot);
    var bl = await tryCatch(fetchBilibiliHot);
    var dy = await tryCatch(fetchDouyinHot);
    var xh = await tryCatch(fetchXhsTopics);
    results = [wb, bl, dy, xh];
  }

  var allDiscoveries = [];

  results.forEach(function(r) {
    var items = (r && r.value) ? r.value : (Array.isArray(r) ? r : []);
    if (items.length > 0) {
      items.forEach(function(item) {
        item.crawl_week = week;
        allDiscoveries.push(item);
      });
    }
  });

  if (allDiscoveries.length > 0) {
    db.insertDiscoveries(allDiscoveries);
    totalTopics = allDiscoveries.length;
    console.log('  Total topics stored: ' + totalTopics);
  }

  console.log('=== Discovery Complete: ' + totalTopics + ' topics ===');
  return { totalTopics: totalTopics, week: week, timestamp: new Date().toISOString() };
}

async function tryCatch(fn) {
  try { return await fn(); } catch(e) { return []; }
}

// ── Weibo hot search (public API, no auth needed) ──
async function fetchWeiboHot() {
  console.log('[Weibo] Fetching hot search...');
  var resp = await client.get('https://weibo.com/ajax/side/hotSearch', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': 'https://weibo.com',
      'Accept': 'application/json, text/plain, */*'
    }
  });

  var data = resp.data;
  var items = [];
  if (data && data.data && data.data.realtime) {
    data.data.realtime.forEach(function(item) {
      if (item.word && item.word.length >= 2) {
        items.push({
          topic_name: item.word,
          platform: 'weibo',
          query_used: 'weibo/api/hotSearch',
          source_url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent(item.word),
          snippet: '热度: ' + (item.num || 0),
          mention_count: Math.round((item.num || 100000) / 100000) || 1
        });
      }
    });
  }
  console.log('  → ' + items.length + ' Weibo hot topics');
  db.logCrawl({ source: 'api', keyword: 'weibo-hot', results_count: items.length, status: 'ok', error: '', crawl_type: 'discovery' });
  return items;
}

// ── Bilibili ranking (public API) ──
async function fetchBilibiliHot() {
  console.log('[Bilibili] Fetching ranking...');
  var resp = await client.get('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com'
    }
  });

  var data = resp.data;
  var items = [];
  if (data && data.data && data.data.list) {
    data.data.list.forEach(function(v) {
      if (v.title && v.title.length >= 2) {
        var shortTitle = v.title.length > 25 ? v.title.substring(0, 25) + '...' : v.title;
        items.push({
          topic_name: shortTitle,
          platform: 'bilibili',
          query_used: 'bilibili/api/ranking',
          source_url: v.short_link || ('https://www.bilibili.com/video/' + v.bvid),
          snippet: '播放: ' + (v.stat ? v.stat.view : 0) + ' | 弹幕: ' + (v.stat ? v.stat.danmaku : 0),
          mention_count: Math.round((v.stat ? v.stat.view : 10000) / 50000) || 1
        });
      }
    });
  }
  console.log('  → ' + items.length + ' Bilibili ranking videos');
  db.logCrawl({ source: 'api', keyword: 'bilibili-hot', results_count: items.length, status: 'ok', error: '', crawl_type: 'discovery' });
  return items;
}

// ── Douyin hot search (public API, no auth needed) ──
async function fetchDouyinHot() {
  console.log('[Douyin] Fetching hot search...');
  var resp = await client.get('https://www.douyin.com/aweme/v1/web/hot/search/list/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': 'https://www.douyin.com'
    }
  });

  var data = resp.data;
  var items = [];
  if (data && data.data && data.data.word_list) {
    data.data.word_list.forEach(function(item) {
      if (item.word && item.word.length >= 2) {
        items.push({
          topic_name: item.word,
          platform: 'douyin',
          query_used: 'douyin/api/hot/search',
          source_url: 'https://www.douyin.com/search/' + encodeURIComponent(item.word),
          snippet: '热度值: ' + (item.hot_value || 0),
          mention_count: Math.round((item.hot_value || 1000000) / 1000000) || 1
        });
      }
    });
  }
  console.log('  → ' + items.length + ' Douyin hot topics');
  db.logCrawl({ source: 'api', keyword: 'douyin-hot', results_count: items.length, status: 'ok', error: '', crawl_type: 'discovery' });
  return items;
}

// ── XHS trending topics via Puppeteer browser automation ──
async function fetchXhsTopics() {
  console.log('[XHS] Fetching trending topics via Puppeteer...');
  try {
    var items = await xhsCrawler.fetchXhsTrendingTopics();
    db.logCrawl({ source: 'puppeteer', keyword: 'xhs-discovery', results_count: items.length, status: 'ok', error: '', crawl_type: 'discovery' });
    return items;
  } catch(e) {
    console.error('[XHS] Puppeteer crawl failed:', e.message);
    db.logCrawl({ source: 'puppeteer', keyword: 'xhs-discovery', results_count: 0, status: 'error', error: e.message, crawl_type: 'discovery' });
    return [];
  }
}

// Filter out junk/non-topic names
function isValidTopicName(name) {
  if (name.length < 2 || name.length > 20) return false;
  // Must contain at least some CJK characters to be a Chinese topic
  if (!/[一-鿿]/.test(name)) return false;
  // Exclude URLs, website names, and utility text
  var junkPatterns = [
    '百度百科', '维基百科', '知乎', '微博', '抖音', '小红书', 'B站', 'Bilibili',
    'www.', '.com', '.cn', '.org', '.net', 'http', '://',
    '下一页', '更多', '登录', '注册', '首页', '搜索', '查看详情',
    '小游戏', '游戏大全', '下载', '安装', 'APP', '官网',
    '怎么读', '拼音', '字典', '是什么意思', '近义词', '反义词',
    'com', 'cn', 'www', '大全-', '在线',
    '诗·', '古诗', '成语', '谚语'
  ];
  for (var i = 0; i < junkPatterns.length; i++) {
    if (name.indexOf(junkPatterns[i]) >= 0) return false;
  }
  return true;
}

// Extract topic names from text using patterns
function extractTopicNames(text) {
  var topics = [];
  var seen = {};

  // Pattern 1: Hashtags
  var hashMatch = text.match(/#([^#\s]{2,20})#/g);
  if (hashMatch) {
    hashMatch.forEach(function(h) {
      var t = h.replace(/#/g, '').trim();
      if (isValidTopicName(t) && !seen[t]) {
        seen[t] = true;
        topics.push(t);
      }
    });
  }

  // Pattern 2: Numbered list items (e.g., "1. 春季穿搭", "TOP1：xxx")
  var numMatch = text.match(/(?:TOP|排名|热度)?\s*\d+\s*[\.\、\：:\s]+(.{2,20})/g);
  if (numMatch) {
    numMatch.forEach(function(m) {
      var t = m.replace(/(?:TOP|排名|热度)?\s*\d+\s*[\.\、\：:\s]+/, '').trim();
      if (isValidTopicName(t) && !seen[t] && !/[点查看阅详]/.test(t)) {
        seen[t] = true;
        topics.push(t);
      }
    });
  }

  // Pattern 3: 「」 or 《》 quoted topics
  var quoteMatch = text.match(/[「《]([^」》]{2,20})[」》]/g);
  if (quoteMatch) {
    quoteMatch.forEach(function(q) {
      var t = q.replace(/[「《」》]/g, '').trim();
      if (isValidTopicName(t) && !seen[t]) {
        seen[t] = true;
        topics.push(t);
      }
    });
  }

  return topics;
}

// ── Weekly crawl: time-filtered keyword crawl ──
async function crawlWeekly(options) {
  var opts = options || {};
  var keywords = opts.keywords || getActiveKeywords();
  var week = db.getCurrentWeek();

  // Add weekly time qualifiers to each keyword
  var weeklyKeywords = [];
  keywords.forEach(function(kw) {
    weeklyKeywords.push(kw + ' 本周');
    weeklyKeywords.push(kw + ' 最近一周');
  });

  console.log('=== Weekly Crawl Start: ' + week + ' ===');
  var result = await crawlAll({
    keywords: weeklyKeywords,
    count: opts.count || 8,
    crawlType: 'weekly'
  });

  return { week: week, totalResults: result.totalResults, timestamp: new Date().toISOString() };
}

// Run directly if called from command line
if (require.main === module) {
  var cmd = process.argv[2];
  if (cmd === 'discover') {
    discoverTrendingTopics({ limit: parseInt(process.argv[3]) || 5 })
      .then(function(r) {
        console.log(JSON.stringify(r));
        process.exit(0);
      })
      .catch(function(e) {
        console.error('Fatal: ' + e.message);
        process.exit(1);
      });
  } else {
    var count = parseInt(process.argv[2]) || 10;
    crawlAll({ count: count })
      .then(function(r) {
        console.log(JSON.stringify(r));
        process.exit(0);
      })
      .catch(function(e) {
        console.error('Fatal: ' + e.message);
        process.exit(1);
      });
  }
}

module.exports = { crawlAll: crawlAll, discoverTrendingTopics: discoverTrendingTopics, crawlWeekly: crawlWeekly, TRACK_KEYWORDS: TRACK_KEYWORDS };
