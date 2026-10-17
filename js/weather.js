// Hourly sky/precipitation summary and icons for the point forecast.
//
// Precipitation, fog and thunder come from the WMO weather code. Cloudiness comes from total
// cloud cover, because some models (HRRR) only emit coarse codes (0 = clear, 3 = overcast).

const PRECIP = {
  drizzle: [51, 53, 55, 56, 57], rain: [61, 63, 65, 66, 67, 80, 81, 82],
  snow: [71, 73, 75, 77, 85, 86], thunder: [95, 96, 99],
};
const LABEL = {
  clear: 'Sunny', partly: 'Partly cloudy', mostly: 'Mostly cloudy', overcast: 'Overcast',
  fog: 'Fog', drizzle: 'Drizzle', rain: 'Rain', snow: 'Snow', thunder: 'Thunderstorm',
};

/** {kind, label, precip: bool} for one hour (wx = {code, cloud, pop, precip}); night swaps sun for moon. */
export function classify(wx, night) {
  const code = wx?.code;
  for (const [kind, codes] of Object.entries(PRECIP)) {
    if (codes.includes(code)) return { kind, label: LABEL[kind], precip: true };
  }
  if (code === 45 || code === 48) return { kind: 'fog', label: LABEL.fog, precip: false };
  const c = wx?.cloud;
  const kind = c == null ? (code >= 3 ? 'overcast' : 'clear')
    : c < 20 ? 'clear' : c < 60 ? 'partly' : c < 85 ? 'mostly' : 'overcast';
  const label = night && kind === 'clear' ? 'Clear' : LABEL[kind];
  return { kind, label, precip: false };
}

/** Short text under the icon: chance of precipitation for wet hours, cloud cover otherwise. */
export function detail(wx, sky, inches) {
  if (sky.precip) {
    if (wx.pop != null) return { text: `${Math.round(wx.pop)}%`, wet: true };
    if (wx.precip != null) return { text: inches ? `${(wx.precip / 25.4).toFixed(2)}″` : `${wx.precip.toFixed(1)}mm`, wet: true };
  }
  return { text: wx?.cloud == null ? '' : `${Math.round(wx.cloud)}%`, wet: false };
}

const SUN = '<circle cx="12" cy="12" r="4.2" fill="#f5b301"/><g stroke="#f5b301" stroke-width="1.6" stroke-linecap="round">' +
  '<path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7 7 17M17 7l1.7-1.7"/></g>';
const MOON = '<path d="M15.5 3.5a8.5 8.5 0 1 0 5 15.4A7 7 0 0 1 15.5 3.5z" fill="#8fa3bf"/>';
const cloud = (fill, dy = 0) => `<path transform="translate(0 ${dy})" d="M7 19h10.5a4.2 4.2 0 0 0 .7-8.3 5.6 5.6 0 0 0-10.8-1.3A4.4 4.4 0 0 0 7 19z" fill="${fill}" stroke="#7b8796" stroke-width="1"/>`;
const SMALL_SUN = '<circle cx="8" cy="8" r="3.4" fill="#f5b301"/><g stroke="#f5b301" stroke-width="1.3" stroke-linecap="round"><path d="M8 1.5v1.6M1.5 8h1.6M3.4 3.4l1.1 1.1M12.6 3.4l-1.1 1.1"/></g>';
const SMALL_MOON = '<path d="M10 2.5a5.5 5.5 0 1 0 3.4 9.9A4.5 4.5 0 0 1 10 2.5z" fill="#8fa3bf"/>';
const drops = color => `<g stroke="${color}" stroke-width="1.6" stroke-linecap="round"><path d="M8.5 19.5l-1 2.5M12.5 19.5l-1 2.5M16.5 19.5l-1 2.5"/></g>`;

const ICONS = {
  clear: n => (n ? MOON : SUN),
  partly: n => `${n ? SMALL_MOON : SMALL_SUN}${cloud('#fff', 2)}`,
  mostly: () => `${SMALL_SUN}${cloud('#e9edf2', 1)}`,
  overcast: () => cloud('#cfd6df', 1),
  fog: () => '<g stroke="#9aa5b1" stroke-width="1.8" stroke-linecap="round"><path d="M4 9h16M3 13h18M5 17h14"/></g>',
  drizzle: () => `${cloud('#dfe5ec', -3)}<g fill="#3d8bd9"><circle cx="9" cy="20" r="1"/><circle cx="13" cy="21" r="1"/><circle cx="17" cy="20" r="1"/></g>`,
  rain: () => `${cloud('#cfd6df', -3)}${drops('#2f7fd1')}`,
  snow: () => `${cloud('#e9edf2', -3)}<g fill="#6aa9e0"><circle cx="8.5" cy="20.5" r="1.3"/><circle cx="12.5" cy="22" r="1.3"/><circle cx="16.5" cy="20.5" r="1.3"/></g>`,
  thunder: () => `${cloud('#b8c1cc', -3)}<path d="M12.5 15.5 9.5 20.5h2.6l-1.3 3.2 4-5.4h-2.7l1.4-2.8z" fill="#f5b301"/>`,
};

export function iconSvg(kind, night, size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind](night)}</svg>`;
}

export const tempVal = (c, unit) => (unit === 'F' ? c * 9 / 5 + 32 : c);
export const fmtTemp = (c, unit) => (c == null ? '–' : `${Math.round(tempVal(c, unit))}°${unit}`);
