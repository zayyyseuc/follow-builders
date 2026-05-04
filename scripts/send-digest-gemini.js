#!/usr/bin/env node

// ============================================================================
// Follow Builders — Daily Digest via Gemini + Resend
// ============================================================================
// Runs in GitHub Actions. Fetches the central feeds, calls Gemini API to
// remix the content into a digest, then sends it via Resend email.
//
// Required env vars (set as GitHub Secrets):
//   GEMINI_API_KEY   — Google AI Studio API key
//   RESEND_API_KEY   — Resend API key
//   DIGEST_EMAIL     — recipient email address
// ============================================================================

const FEED_X_URL = 'https://raw.githubusercontent.com/zayyyseuc/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zayyyseuc/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL = 'https://raw.githubusercontent.com/zayyyseuc/follow-builders/main/feed-blogs.json';

const OPENAI_API_URL = 'https://yh.m7ai.com/v1/chat/completions';

// ---------------------------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------

function buildPrompt(feedX, feedPodcasts, feedBlogs) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  const sections = [];

  // X/Twitter
  const builders = feedX?.x || [];
  if (builders.length > 0) {
    const builderText = builders.map(b => {
      const tweets = b.tweets.map(t => `  - ${t.text}\n    ${t.url}`).join('\n');
      return `【${b.name}】(${b.bio})\n${tweets}`;
    }).join('\n\n');
    sections.push(`=== X/Twitter ===\n${builderText}`);
  }

  // Blogs
  const blogs = feedBlogs?.blogs || [];
  if (blogs.length > 0) {
    const blogText = blogs.map(b =>
      `【${b.name}】${b.title}\n${b.url}\n${b.content?.slice(0, 800) || ''}`
    ).join('\n\n');
    sections.push(`=== 官方博客 ===\n${blogText}`);
  }

  // Podcasts
  const podcasts = feedPodcasts?.podcasts || [];
  if (podcasts.length > 0) {
    const podText = podcasts.map(p =>
      `【${p.name}】${p.title}\n${p.url}\n${p.transcript?.slice(0, 2000) || ''}`
    ).join('\n\n');
    sections.push(`=== 播客 ===\n${podText}`);
  }

  if (sections.length === 0) {
    return null;
  }

  return `你是一个AI行业信息整理助手。请把下面的原始内容整理成一份简洁的中文日报，风格像一个懂行的朋友在给你分享今天值得关注的事。

要求：
- 用中文写作，技术术语（AI、LLM、API等）保留英文
- 每个人/来源写2-4句话，抓住最有价值的观点
- 跳过无实质内容的推文
- 每条内容后附上原始链接
- 博客文章给出核心要点摘要（100字左右）
- 播客给出主要洞察（150字左右）
- 开头写"AI Builder 日报 — ${today}"
- 结尾写一句话总结今天最值得关注的一件事

原始内容如下：

${sections.join('\n\n')}`;
}

// ---------------------------------------------------------------------------

async function callOpenAI(prompt, apiKey) {
  const res = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'codex',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048,
      temperature: 0.7
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('API returned empty response');
  return text;
}

// ---------------------------------------------------------------------------

async function sendEmail(text, apiKey, toEmail) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric'
  });

  // Convert plain text to simple HTML for better email rendering
  const html = `<pre style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; white-space: pre-wrap; max-width: 680px;">${text}</pre>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builder 日报 <onboarding@resend.dev>',
      to: [toEmail],
      subject: `AI Builder 日报 — ${today}`,
      html,
      text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend error: ${err.message || JSON.stringify(err)}`);
  }

  return await res.json();
}

// ---------------------------------------------------------------------------

async function main() {
  const geminiKey = process.env.OPENAI_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.DIGEST_EMAIL;

  if (!geminiKey) throw new Error('OPENAI_API_KEY not set');
  if (!resendKey) throw new Error('RESEND_API_KEY not set');
  if (!toEmail) throw new Error('DIGEST_EMAIL not set');

  console.log('Fetching feeds...');
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL),
    fetchJSON(FEED_BLOGS_URL)
  ]);

  const xCount = feedX?.x?.length || 0;
  const podCount = feedPodcasts?.podcasts?.length || 0;
  const blogCount = feedBlogs?.blogs?.length || 0;
  console.log(`Feeds loaded: ${xCount} builders, ${podCount} podcasts, ${blogCount} blog posts`);

  if (xCount === 0 && podCount === 0 && blogCount === 0) {
    console.log('No content today, skipping.');
    return;
  }

  const prompt = buildPrompt(feedX, feedPodcasts, feedBlogs);
  if (!prompt) {
    console.log('Nothing to digest.');
    return;
  }

  console.log('Calling OpenAI proxy...');
  const digest = await callOpenAI(prompt, geminiKey);
  console.log(`Digest generated (${digest.length} chars)`);

  console.log(`Sending email to ${toEmail}...`);
  const result = await sendEmail(digest, resendKey, toEmail);
  console.log('Email sent:', result.id);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
