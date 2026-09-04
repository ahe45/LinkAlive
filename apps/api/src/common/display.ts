export function toDisplayUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.username = '';
  url.password = '';
  const hadQuery = url.search.length > 0;
  url.search = hadQuery ? '?masked' : '';
  url.hash = '';
  return url.toString();
}
