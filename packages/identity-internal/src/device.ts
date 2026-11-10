/** User-Agent labels are descriptive hints, never proof of device identity. */
export function describeDevice(agent?: string): {
  browser?: string;
  operatingSystem?: string;
  device?: string;
} {
  if (!agent) return {};
  const browsers = [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ['Opera', /OPR\/([\d.]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/],
  ] as const;
  const found = browsers.find(([, pattern]) => pattern.test(agent));
  const browser = found ? `${found[0]} ${agent.match(found[1])?.[1]?.split('.')[0]}` : undefined;
  const operatingSystem = /iPhone|iPad|iPod/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Macintosh|Mac OS X/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : undefined;
  const device =
    /iPad|Tablet/.test(agent) || (/Android/.test(agent) && !/Mobile/.test(agent))
      ? 'Tablet'
      : /Mobile|iPhone|iPod/.test(agent)
        ? 'Mobile'
        : operatingSystem
          ? 'Desktop'
          : undefined;
  return { browser, operatingSystem, device };
}
