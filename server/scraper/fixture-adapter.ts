export const fixtureAdapterCode = `export default function parsePage({ html, url, load }) {
  const document = load(html);
  document('script, style, nav, footer, .advert').remove();
  const title = document('h1').first().text().trim();
  const absolute = (href) => href ? new URL(href, url).href : null;
  if (document('.chapters a').length) {
    return {
      kind: 'index', title,
      author: document('.author').text().trim() || null,
      language: document('html').attr('lang') || null,
      synopsis: document('.synopsis').text().trim() || null,
      chapters: document('.chapters a').map((index, anchor) => ({
        title: document(anchor).text().trim(), url: absolute(document(anchor).attr('href'))
      })).get()
    };
  }
  const contentSelector = document('.chapter-body').length ? '.chapter-body' : '#reader-text';
  if (document(contentSelector).length === 1) {
    const nextPage = document('a[data-page="continuation"]').first();
    const nextChapter = document('a.next-chapter, a[rel="next"]:not([data-page="continuation"])').first();
    return {
      kind: 'chapter', title, contentSelector,
      paragraphs: document(contentSelector).find('p, .paragraph').map((index, paragraph) => document(paragraph).text().trim()).get(),
      nextPageUrl: absolute(nextPage.attr('href')),
      nextChapterUrl: absolute(nextChapter.attr('href'))
    };
  }
  return { kind: 'blocked', reason: 'No readable chapter or chapter index found.' };
}`
