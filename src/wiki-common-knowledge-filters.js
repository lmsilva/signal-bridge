/**
 * Title / description denylist for Wiki Common Knowledge.
 */

function matchesDenylist(text, denylist = []) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return false;
  for (const term of denylist || []) {
    const needle = String(term || '').trim().toLowerCase();
    if (needle && hay.includes(needle)) return true;
  }
  return false;
}

function articleBlocked(article = {}, { denylist = [], filterDistressing = true } = {}) {
  if (!filterDistressing) return false;
  const title = article.title || article.normalizedtitle || '';
  const desc = article.description || article.extract || '';
  return matchesDenylist(title, denylist) || matchesDenylist(desc, denylist);
}

function filterArticles(articles = [], options = {}) {
  return (articles || []).filter((a) => !articleBlocked(a, options));
}

module.exports = {
  matchesDenylist,
  articleBlocked,
  filterArticles,
};
