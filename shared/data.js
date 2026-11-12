/* Teams and drivers (2026 grid). Shared by the server and the browser. */
(function (root) {
  'use strict';
  const F1 = (root.F1 = root.F1 || {});

  // Game version: goes up by one with every update
  F1.VERSION = 8;

  // Simple livery colours: primary = main body, secondary = engine cover / wings, accent = helmet & details.
  // ui = the team colour used for menus, the timing tower, labels and the minimap (bright on dark backgrounds).
  F1.TEAMS = [
    { id: 'mclaren',  name: 'McLaren',         primary: '#FF8000', secondary: '#232326', accent: '#FFFFFF', ui: '#FF8000' },
    { id: 'mercedes', name: 'Mercedes',        primary: '#C3C9CD', secondary: '#141414', accent: '#00D2BE', ui: '#27F4D2' },
    { id: 'redbull',  name: 'Red Bull Racing', primary: '#1C2B5E', secondary: '#E10600', accent: '#FFC906', ui: '#2445D1' },
    { id: 'ferrari',  name: 'Ferrari',         primary: '#DC0000', secondary: '#F4F4F4', accent: '#FFE600', ui: '#E8002D' },
    { id: 'williams', name: 'Williams',        primary: '#0F3FA8', secondary: '#00A3E0', accent: '#FFFFFF', ui: '#64C4FF' },
    { id: 'rb',       name: 'Racing Bulls',    primary: '#F2F3F5', secondary: '#2148D6', accent: '#E10600', ui: '#6692FF' },
    { id: 'aston',    name: 'Aston Martin',    primary: '#005F4E', secondary: '#C4E000', accent: '#111111', ui: '#229971' },
    { id: 'haas',     name: 'Haas',            primary: '#F4F4F4', secondary: '#141414', accent: '#E1001A', ui: '#B6121B' },
    { id: 'audi',     name: 'Audi',            primary: '#B8BDC2', secondary: '#141414', accent: '#E4002B', ui: '#FF4D17' },
    { id: 'alpine',   name: 'Alpine',          primary: '#0055C8', secondary: '#FF74B8', accent: '#FFFFFF', ui: '#FF87BC' },
    { id: 'cadillac', name: 'Cadillac',        primary: '#101010', secondary: '#F4F4F4', accent: '#9C9C9C', ui: '#D4AF37', split: true }
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
  /* The team's interface colour (strong and readable on the dark menus and timing tower). */
  F1.teamUiColor = function (t) { return t ? t.ui : '#888888'; };
  F1.teamOfDriver = function (driverId) { const d = driverMap[driverId]; return d ? teamMap[d.team] : null; };

  if (typeof module !== 'undefined' && module.exports) module.exports = F1;
})(typeof window !== 'undefined' ? window : globalThis);
