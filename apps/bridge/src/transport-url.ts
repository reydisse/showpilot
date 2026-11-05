/** Credentials belong only in the transport header, including when loading old config. */
export function credentialFreeUrl(input: string): URL {
  const url = new URL(input);
  url.username = "";
  url.password = "";
  for (const name of [...url.searchParams.keys()]) {
    if (/^(key|apikey|api-key|api_key|authbridgekey)$/i.test(name)) url.searchParams.delete(name);
  }
  return url;
}
