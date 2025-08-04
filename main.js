
import { Actor, log } from 'apify';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import dayjs from 'dayjs';
import pLimit from 'p-limit';

const pick = (arr, n) => arr.slice(0, n);

async function fetchRSS(url) {
  try {
    const { data } = await axios.get(url, { timeout: 20000 });
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
    const xml = parser.parse(data);
    const channel = xml.rss?.channel || xml.feed;
    const items = channel?.item || channel?.entry || [];
    return items.map(i => ({
      title: i.title?.['#text'] || i.title || '',
      link: i.link?.href || i.link || i.guid || '',
      publishedAt: i.pubDate || i.published || i.updated || null,
      source: (channel?.title?.['#text'] || channel?.title || new URL(url).hostname),
    }));
  } catch(e) {
    log.warning('RSS fail ' + url + ': ' + e.message);
    return [];
  }
}

async function callOpenAI(system, user, model) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.4
  };
  const { data } = await axios.post('https://api.openai.com/v1/chat/completions', body, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 60000
  });
  return data.choices[0].message.content;
}

Actor.main(async () => {
  const input = await Actor.getInput() || {};
  const {
    sources = [],
    maxArticles = 60,
    openaiModel = 'gpt-4o-mini',
    includeCTA = true,
    brandCTA = 'Dacă vrei sprijin, programează o sesiune pe psiconcept.ro.',
    postWordTarget = 150
  } = input;

  const limit = pLimit(5);
  const lists = await Promise.all(sources.map(u => limit(() => fetchRSS(u))));
  let items = lists.flat().filter(i => i.title && i.link);
  const seen = new Set();
  items = items.filter(i => !seen.has(i.link) && seen.add(i.link));
  items.sort((a,b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  items = pick(items, maxArticles);

  const listPrompt = items.map((it, idx) =>
    \`\${idx+1}. [\${it.source}] "\${it.title}" — \${it.link}\`).join('\n');

  const selectorSystem = 'Alege 3 știri relevante psihologic și întoarce doar numerele lor separate prin virgulă.';
  const choice = await callOpenAI(selectorSystem, listPrompt, openaiModel);
  const indexes = choice.match(/\d+/g)?.map(n => parseInt(n.trim(), 10))?.slice(0,3) || [];

  const dataset = await Actor.openDataset();
  for (const idx of indexes) {
    const it = items[idx-1];
    if (!it) continue;
    const postSystem = 'Scrie o postare Facebook de ' + postWordTarget + ' cuvinte, ton cald, clar.';
    const post = await callOpenAI(postSystem, it.title, openaiModel);
    await dataset.pushData({ ...it, fbPost: post, createdAt: new Date().toISOString() });
  }
  log.info('Done.');
});
