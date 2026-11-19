#!/usr/bin/env node
// Offline checks for the startup digest's anti-hallucination rules.
// Run: node scripts/test-startup-grounding.mjs
import assert from 'assert/strict';
import { groundDeals, groundTimeline, NOT_STATED } from './lib/startup-grounding.mjs';
import { extractBody, cardTitle } from './startup-digest.mjs';
import { diffPortfolio, slugsFrom } from './vc-portfolio.mjs';
import { groundPicks } from './ai-weekly.mjs';

const articles = [
  { title: 'Refilled taps $5.6 million Series A', desc: '', pubDate: 'Fri, 13 Nov 2026 01:00:00 GMT', link: 'https://x/1',
    body: 'Sydney startup Refilled has raised $5.6 million in a Series A after finding a market for its Australian-made drinks dispensers. OIF Ventures led the round, with backing from Melt Ventures. The money will be used to expand into Melbourne and Brisbane offices.' },
  { title: 'Six startups score NSW grants', desc: '', pubDate: 'Wed, 18 Nov 2026 01:00:00 GMT', link: 'https://x/2',
    body: 'Celosia Therapeutics has scored a $2 million grant from the NSW Emerging Technology Commercialisation Fund.' },
  { title: 'Firmus raises $100 million for AI factory', desc: '', pubDate: 'Wed, 18 Nov 2026 01:00:00 GMT', link: 'https://x/3', body: 'Firmus builds an AI factory in Tasmania.' },
];

const r = groundDeals([
  { refs: [1], company: 'Refilled', city: 'Sydney', round: 'Series A', amount: 'A$5.6 million',
    investors: ['OIF Ventures', 'Blackbird'],
    what_quote: 'found a market for its Australian-made drinks dispensers in every office', what_zh: '捏造的描述',
    use_quote: 'The money will be used to expand into Melbourne and Brisbane offices', use_zh: '拓展墨爾本與布里斯本' },
  { refs: [1], company: 'Kestrel Logic', round: 'Series A', amount: 'A$12M' },        // invented company
  { refs: [42], company: 'Q-CTRL', amount: 'US$290 million' },                        // invented reference
  { refs: [2], company: 'Celosia Therapeutics', kind: 'grant', round: 'Series B', amount: '$20 million',
    program: 'NSW Emerging Technology Commercialisation Fund', city: 'Melbourne' },  // wrong round, amount, city
  { refs: [3], company: 'Firmus', round: '', amount: '$100 million' },                  // DC → DC briefing
], articles);

assert.deepEqual(r.kept.map(d => d.company), ['Refilled', 'Celosia Therapeutics']);
assert.equal(r.dropped.length, 2);
assert.deepEqual(r.dc, ['Firmus']);
const [refilled, celosia] = r.kept;
assert.deepEqual(refilled.investors, ['OIF Ventures']);           // Blackbird not in text
assert.equal(refilled.what, NOT_STATED);                           // quote not verbatim
assert.equal(refilled.use, '拓展墨爾本與布里斯本');                 // quote verbatim
assert.equal(celosia.round, NOT_STATED);
assert.equal(celosia.amount, NOT_STATED);
assert.equal(celosia.city, NOT_STATED);
assert.equal(celosia.program, 'NSW Emerging Technology Commercialisation Fund');
assert.match(cardTitle(celosia), /^🏛️ 政府補助｜Celosia Therapeutics 獲 NSW/);
assert.match(cardTitle(refilled), /^🚀 新創融資｜\[Sydney\] Refilled Series A A\$5\.6 million$/);

// '5.6' must not match inside '15.62'.
assert.equal(groundDeals([{ refs: [1], company: 'Refilled', amount: '$15.62 million' }], articles).kept[0].amount, NOT_STATED);

const tl = groundTimeline(
  { Refilled: [{ n: 1, zh: '種子輪' }, { n: 2, zh: '同名遊戲' }, { n: 9, zh: '不存在' }] },
  { Refilled: [
    { title: 'Refilled raises $1.3m seed', pubDate: 'Mon, 01 Jun 2026 00:00:00 GMT', link: 'a', publisher: 'SD' },
    { title: 'Crimson Desert patch fills its map', pubDate: 'Sat, 02 May 2026 00:00:00 GMT', link: 'b', publisher: 'Forbes' },
  ] });
assert.deepEqual(tl.Refilled.map(t => t.link), ['a']);

assert.equal(extractBody('<p>Accelerator Ag tech AI Fintech Funding Global tech Other tech People Politics Quantum</p><p>Prefer Startup Daily Refilled has raised $5.6 million in a Series A round this week.</p>', 1000),
  'Refilled has raised $5.6 million in a Series A round this week.');

assert.deepEqual(slugsFrom('<a href="/portfolio/canva">x</a><a href="https://www.blackbird.vc/portfolio/zip/">y</a><a href="/portfolio/canva">', '/portfolio/', 'https://www.blackbird.vc'), ['canva', 'zip']);
assert.deepEqual(diffPortfolio(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd', 'e']).added, ['e']);
assert.equal(diffPortfolio(['a', 'b', 'c', 'd'], ['a']).status, 'failed');
assert.equal(diffPortfolio(undefined, ['a']).status, 'baseline');
assert.deepEqual(groundPicks([3, 3, 99, '2', 0, 5.5, 7], 20), [3, 2, 7]);

console.log('startup grounding: all checks passed');
