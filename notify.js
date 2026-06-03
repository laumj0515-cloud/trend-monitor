var nodemailer = require('nodemailer');
var fs = require('fs');
var path = require('path');

var configFile = path.join(__dirname, 'email_config.json');
var transporter = null;

function loadConfig() {
  try {
    var cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    transporter = nodemailer.createTransport({
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      auth: { user: cfg.email, pass: cfg.authCode }
    });
    return cfg.to || cfg.email;
  } catch(e) {
    console.log('[Notify] Email not configured. Create email_config.json to enable alerts.');
    return null;
  }
}

function sendAlert(subject, body) {
  var to = loadConfig();
  if (!to || !transporter) return;

  var mail = {
    from: transporter.options.auth.user,
    to: to,
    subject: '[TrendPulse] ' + subject,
    text: body + '\n\n---\nTrendPulse 热点监测系统\n时间: ' + new Date().toLocaleString()
  };

  transporter.sendMail(mail, function(err) {
    if (err) console.error('[Notify] Send failed:', err.message);
    else console.log('[Notify] Alert sent: ' + subject);
  });
}

module.exports = {
  crawlFailed: function(detail) {
    sendAlert('爬取失败警报', '每日关键词爬取执行失败。\n\n错误信息: ' + (detail || '未知错误') + '\n\n请检查服务器状态。');
  },
  discoveryFailed: function(detail) {
    sendAlert('热点发现失败', '每周热点发现执行失败。\n\n错误信息: ' + (detail || '未知错误') + '\n\n请检查服务器状态。');
  },
  test: function() {
    sendAlert('测试邮件', '如果你收到这封邮件，说明 TrendPulse 邮件通知配置成功。');
  }
};
