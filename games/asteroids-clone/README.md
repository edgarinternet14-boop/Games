# Asteroids Clone

A single-file HTML5 Canvas remake of the classic vector arcade shooter. Everything (HTML, CSS and vanilla JavaScript) lives in [`index.html`](index.html). There are no images, audio files, libraries or build step: the ship, rocks and text are drawn as wireframe polygons, and the sound effects are generated with the Web Audio API.

## Play

Open `index.html` in any modern browser: double-click it, or serve the folder (`npx serve .` / `python3 -m http.server`) and browse to it. If GitHub Pages is enabled for the repo, the game is at `/games/asteroids-clone/`.

## Controls

### Keyboard

| Action        | Keys                                   |
| ------------- | -------------------------------------- |
| Rotate left   | `←` or `A`                             |
| Rotate right  | `→` or `D`                             |
| Thrust        | `↑` or `W`                             |
| Fire          | `Space` (tap, or hold for rapid fire)  |
| Hyperspace    | `↓`, `S` or `H`                        |
| Pause/resume  | `P` or `Esc`                           |
| Mute/unmute   | `M`                                    |
| Start/restart | `Enter` (or `Space` / `R`)             |

The game pauses on its own when the window loses focus or the tab is hidden.

### Touch

On phones and tablets, on-screen buttons appear: **◀ ▶** rotate, **▲** thrust, **●** fire and **H** hyperspace. Tap the screen to start, restart or resume.

## Rules

- Shoot the asteroids. Large rocks split into two medium ones, medium into two small ones, and small rocks are destroyed. Each split piece is smaller **and faster** than the rock it came from.
- Running into a rock costs a life (the rock breaks too). You start with **3 lives** and earn an extra one every **10,000 points**.
- After a respawn the ship blinks and is invulnerable for 2.5 seconds. The game waits for the centre of the screen to clear before bringing you back.
- Clearing every rock starts the next wave, with more and faster asteroids (4, 6, 8, 10, then 11 per wave).
- Hyperspace teleports you to a random spot and kills your momentum. It can drop you right next to a rock.
- Everything wraps around the edges: fly off one side and you come back on the opposite side.

| Target          | Points |
| --------------- | ------ |
| Large asteroid  | 20     |
| Medium asteroid | 50     |
| Small asteroid  | 100    |

Your high score is saved in the browser's `localStorage`.

## How it works

- **Movement:** thrust adds acceleration along the ship's heading, velocity carries over between frames (momentum) with a slight exponential drag, and top speed is capped.
- **Screen wrapping:** positions wrap on both axes. Objects that straddle an edge are drawn on both sides, and collisions use the shortest distance around the wrap, so a rock half over the edge is still solid.
- **Collision detection:** a cheap radius check comes first. For pairs that pass it, an exact polygon test follows. A bullet's path over each step is tested against the asteroid's actual jagged outline, so shots can't tunnel through small rocks, and the ship's hull is checked edge by edge against the asteroid polygon.
- **Game loop:** `requestAnimationFrame` measures the real frame time (clamped after hitches or tab switches) and splits it into equal sub-steps of at most 1/120 s. Play speed is the same on 30 Hz, 60 Hz and 144 Hz+ displays.
- **Resolution independence:** the shorter side of the screen is always 800 world units. The canvas is sized for `devicePixelRatio` and stays sharp on high-DPI screens.

Tuning values (ship thrust, drag, bullet speed, asteroid sizes and speeds, lives) are in the `CFG` and `SIZES` constants at the top of the script.
