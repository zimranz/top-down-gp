/* Teams and drivers (2026 grid). Shared by the server and the browser. */
(function (root) {
  'use strict';
  const F1 = (root.F1 = root.F1 || {});

  // Simple livery colours: primary = main body, secondary = engine cover / wings, accent = helmet & details.
  F1.TEAMS = [
    { id: 'mclaren',  name: 'McLaren',         primary: '#FF8000', secondary: '#232326', accent: '#FFFFFF' },
    { id: 'mercedes', name: 'Mercedes',        primary: '#C3C9CD', secondary: '#141414', accent: '#00D2BE' },
    { id: 'redbull',  name: 'Red Bull Racing', primary: '#1C2B5E', secondary: '#E10600', accent: '#FFC906' },
    { id: 'ferrari',  name: 'Ferrari',         primary: '#DC0000', secondary: '#F4F4F4', accent: '#FFE600' },
    { id: 'williams', name: 'Williams',        primary: '#0F3FA8', secondary: '#00A3E0', accent: '#FFFFFF' },
    { id: 'rb',       name: 'Racing Bulls',    primary: '#F2F3F5', secondary: '#2148D6', accent: '#E10600' },
    { id: 'aston',    name: 'Aston Martin',    primary: '#005F4E', secondary: '#C4E000', accent: '#111111' },
    { id: 'haas',     name: 'Haas',            primary: '#F4F4F4', secondary: '#141414', accent: '#E1001A' },
    { id: 'audi',     name: 'Audi',            primary: '#B8BDC2', secondary: '#141414', accent: '#E4002B' },
    { id: 'alpine',   name: 'Alpine',          primary: '#0055C8', secondary: '#FF74B8', accent: '#FFFFFF' },
    { id: 'cadillac', name: 'Cadillac',        primary: '#101010', secondary: '#F4F4F4', accent: '#9C9C9C', split: true }
  ];

  F1.DRIVERS = [
    { id: 'NOR', name: 'Lando Norris',        number: 1,  team: 'mclaren' },
    { id: 'PIA', name: 'Oscar Piastri',       number: 81, team: 'mclaren' },
    { id: 'RUS', name: 'George Russell',      number: 63, team: 'mercedes' },
    { id: 'ANT', name: 'Kimi Antonelli',      number: 12, team: 'mercedes' },
    { id: 'VER', name: 'Max Verstappen',      number: 3,  team: 'redbull' },
    { id: 'HAD', name: 'Isack Hadjar',        number: 6,  team: 'redbull' },
    { id: 'LEC', name: 'Charles Leclerc',     number: 16, team: 'ferrari' },
    { id: 'HAM', name: 'Lewis Hamilton',      number: 44, team: 'ferrari' },
    { id: 'ALB', name: 'Alex Albon',          number: 23, team: 'williams' },
    { id: 'SAI', name: 'Carlos Sainz',        number: 55, team: 'williams' },
    { id: 'LAW', name: 'Liam Lawson',         number: 30, team: 'rb' },
    { id: 'LIN', name: 'Arvid Lindblad',      number: 41, team: 'rb' },
    { id: 'ALO', name: 'Fernando Alonso',     number: 14, team: 'aston' },
    { id: 'STR', name: 'Lance Stroll',        number: 18, team: 'aston' },
    { id: 'BEA', name: 'Oliver Bearman',      number: 87, team: 'haas' },
    { id: 'CAM', name: 'Rafael Câmara',       number: 50, team: 'haas' },
    { id: 'HUL', name: 'Nico Hülkenberg',     number: 27, team: 'audi' },
    { id: 'BOR', name: 'Gabriel Bortoleto',   number: 5,  team: 'audi' },
    { id: 'GAS', name: 'Pierre Gasly',        number: 10, team: 'alpine' },
    { id: 'COL', name: 'Franco Colapinto',    number: 43, team: 'alpine' },
    { id: 'PER', name: 'Sergio Pérez',        number: 11, team: 'cadillac' },
    { id: 'BOT', name: 'Valtteri Bottas',     number: 77, team: 'cadillac' }
  ];

  const teamMap = {};
  F1.TEAMS.forEach(function (t) { teamMap[t.id] = t; });
  const driverMap = {};
  F1.DRIVERS.forEach(function (d) { driverMap[d.id] = d; });

  F1.team = function (id) { return teamMap[id]; };
  F1.driver = function (id) { return driverMap[id]; };
  /* A colour that stays visible on dark backgrounds (e.g. Red Bull navy -> yellow accent). */
  function lum(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  F1.teamUiColor = function (t) {
    if (lum(t.primary) > 0.22) return t.primary;
    return lum(t.secondary) > lum(t.accent) ? t.secondary : t.accent;
  };
  F1.teamOfDriver = function (driverId) { const d = driverMap[driverId]; return d ? teamMap[d.team] : null; };

  if (typeof module !== 'undefined' && module.exports) module.exports = F1;
})(typeof window !== 'undefined' ? window : globalThis);
