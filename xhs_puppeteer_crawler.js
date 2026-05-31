var puppeteer = require('puppeteer');
var path = require('path');
var fs = require('fs');

var cookieFile = path.join(__dirname, 'xhs_cookies.json');
var XHS_COOKIES = [];
try {
  XHS_COOKIES = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
} catch(e) {
  console.error('[XHS] Could not load xhs_cookies.json:', e.message);
}

var browser = null;
var browserBusy = false;
var idleTimer = null;

async function getBrowser() {
  if (browser && browser.isConnected()) {
    clearTimeout(idleTimer);
    return browser;
  }

  console.log('[XHS Puppeteer] Launching browser...');
  browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  return browser;
}

function scheduleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async function() {
    if (browser && !browserBusy) {
      console.log('[XHS Puppeteer] Closing idle browser...');
      try { await browser.close(); } catch(e) {}
      browser = null;
    }
  }, 120000); // 2 min idle timeout
}

async function fetchXhsTrendingTopics() {
  if (browserBusy) {
    console.log('[XHS] Browser busy, skipping...');
    return [];
  }

  browserBusy = true;
  var page = null;

  try {
    var b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

    // Set cookies
    await page.setCookie(...XHS_COOKIES);

    // Capture the trending API response
    var trendingData = null;
    var trendingPromise = new Promise(function(resolve) {
      var timeout = setTimeout(function() { resolve(null); }, 15000);

      page.on('response', async function(response) {
        var url = response.url();
        if (url.indexOf('querytrending') >= 0 && url.indexOf('search_type=trend') >= 0 && !trendingData) {
          try {
            var body = await response.text();
            var data = JSON.parse(body);
            if (data.code === 1000 && data.data && data.data.queries) {
              clearTimeout(timeout);
              trendingData = data;
              resolve(data);
            }
          } catch(e) {}
        }
      });
    });

    // Navigate to XHS explore
    console.log('[XHS] Navigating to explore page...');
    await page.goto('https://www.xiaohongshu.com/explore', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait for trending data
    var data = await trendingPromise;

    // Close page immediately
    await page.close();
    page = null;

    if (!data || !data.data || !data.data.queries) {
      console.log('[XHS] No trending data captured');
      return [];
    }

    var items = [];
    data.data.queries.forEach(function(q) {
      var name = q.search_word || q.title || '';
      if (name.length >= 2 && name.length <= 30) {
        items.push({
          topic_name: name,
          platform: 'xhs',
          query_used: 'xhs/api/querytrending',
          source_url: 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(name) + '&type=51',
          snippet: q.desc || '',
          mention_count: 1
        });
      }
    });

    console.log('[XHS] → ' + items.length + ' trending topics');
    return items;

  } catch(e) {
    console.error('[XHS] Puppeteer error:', e.message);
    if (page) {
      try { await page.close(); } catch(e2) {}
    }
    return [];
  } finally {
    browserBusy = false;
    if (page) {
      try { await page.close(); } catch(e) {}
    }
    scheduleClose();
  }
}

module.exports = { fetchXhsTrendingTopics: fetchXhsTrendingTopics };
