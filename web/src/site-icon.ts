export type IconSite = {
  id: string;
  url: string;
  enabled: boolean;
  icon?: string;
  icon_revision?: number;
};

export function cachedIconSources(site: IconSite, sources: unknown): string[] {
  const expected = `/api/sites/${site.id}/icon/image`;
  if (!Array.isArray(sources) || !sources.includes(expected)) return [];
  return [
    site.icon_revision == null
      ? expected
      : `${expected}?v=${encodeURIComponent(site.icon_revision)}`,
  ];
}
