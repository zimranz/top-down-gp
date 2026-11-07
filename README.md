# Top-Down GP

A top-down F1 racing game you can play in the browser, alone or online with up to 8 friends.

- **2026 grid**: all 11 teams and 22 drivers with their race numbers and team colours
- **Five real circuits**: Monza, Silverstone, Abu Dhabi (Yas Marina), Spa-Francorchamps and Interlagos, built from the real track outlines at real scale
- **Practice mode**: you drive out of your team's garage in the pit lane (80 km/h limiter) while AI cars are already lapping
- **Grand Prix mode** (single player): pick your track, driver, number of opponents and difficulty, then qualifying (none, or 1–5 laps) decides the grid, five start lights, and a race of 1–7 laps
- **Online mode**: room codes, a lobby, qualifying (none, or 1–5 laps), then a race (1–7 laps) with up to 8 friends
- **AI drivers** fill the empty seats (easy / medium / hard). They make occasional, realistic mistakes (running wide, braking too late), and they follow exactly the same physics as you.
- **Realistic contact**: cars bump with real momentum, but tyres resist being shoved. Rubbing costs time, a hard punt on a rear corner can spin you, and nobody gets thrown off the track by a light touch. There is no damage.
- **Track limits**: grass and gravel slow you down hard if you arrive fast, but you can drive back out (about 100 km/h on grass, 65 km/h in gravel). There are no penalties.
- **DRS**: in a DRS zone, press Shift or Space. In races you need to be within 1 second of the car ahead at the detection line, from lap 2 onwards.
- **HUD**: timing tower with your row highlighted, position, lap, current/last/best lap, speed, gear, DRS / pit limiter light, minimap, a "YOU" marker over your car, and an on-screen **Pause (P)** button
- **Steering sensitivity** setting, available on the home screen and in the pause menu

## Controls

| Key | Action |
| --- | --- |
| ↑ or W | Throttle |
| ↓ or S | Brake (hold when stopped to reverse) |
| ← → or A D | Steer |
| Shift or Space | Open DRS (when it is available) |
| R | Reset the car onto the track (if you're stuck) |
| Esc or P | Pause menu / settings |

## Run it on your computer

You need [Node.js](https://nodejs.org) (the LTS version).

```bash
npm install
npm start
```

Then open http://localhost:3000.

To play with someone on the **same Wi-Fi**, they open `http://YOUR-LOCAL-IP:3000` (for example `http://192.168.1.23:3000`).
On Windows you can find your local IP with `ipconfig`. Allow Node.js through the firewall when Windows asks.

## Put it online (GitHub + Render)

1. Create a new repository on GitHub, then from this folder run:
   ```bash
   git init
   git add .
   git commit -m "First version"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```
2. On Render: **New → Web Service**, connect GitHub, and pick the repository.
3. Settings: Runtime **Node**, Build command `npm install`, Start command `npm start`, Region **Frankfurt**, Instance type **Free**.
4. Deploy. Your friends open the `https://….onrender.com` link, or you can send them an invite link from the lobby.

Every `git push` after that redeploys the game automatically.
On the free plan the server goes to sleep after 15 minutes with nobody connected. The first visit after that takes about a minute while it wakes up.

## Project layout

```
server.js            game server: rooms, lobby, authoritative 60 Hz race simulation
shared/data.js       teams, drivers, numbers, colours
shared/tracks.js     circuit outlines, kerbs, gravel, barriers, pit lane, DRS zones, racing line
shared/sim.js        car physics, collisions, AI drivers, practice/qualifying/race rules
public/index.html    menus and screens
public/css/style.css styling
public/js/render.js  canvas drawing: track, cars, HUD, minimap
public/js/hud.js     timing tower / dashboard data shared by every mode
public/js/game-local.js   practice + Grand Prix (run in the browser)
public/js/game-online.js  online client: instant local response + smoothing of other cars
public/js/main.js    menus, lobby, results, settings, main loop
```

The files in `shared/` run on both the server and in the browser, so the physics is the same on both.

## Credits

Circuit outlines are derived from [f1-circuits](https://github.com/bacinger/f1-circuits) by Tomislav Bacinger (MIT licence; see `THIRD_PARTY_NOTICES.md`).

This is a private fan project. It is not affiliated with Formula 1, the FIA or any team.
