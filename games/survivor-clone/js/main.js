import BootScene from './scenes/BootScene.js';
import GameScene from './scenes/GameScene.js';

// Entry point. Phaser itself is loaded as a global from the CDN in index.html.
//
// No physics plugin is configured on purpose: the hundreds of enemies, bullets
// and gems are pooled plain Images driven by EnemyManager's spatial hash, which
// is far cheaper than giving every one of them an Arcade body.
const config = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0d1014',
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  render: {
    antialias: true,
    powerPreference: 'high-performance',
  },
  input: {
    activePointers: 2,
  },
  scene: [BootScene, GameScene],
};

const game = new Phaser.Game(config);

// When a phone rotates, Phaser measures the page during the orientation event,
// before layout has caught up, and then records the real size without applying
// it, leaving the canvas at the old dimensions. Measuring and refreshing on
// every resize keeps RESIZE mode honest.
window.addEventListener('resize', () => {
  if (!game.isBooted) {
    return;
  }
  game.scale.getParentBounds();
  game.scale.refresh();
});

// Exposed for poking at the running game from the dev-tools console.
window.game = game;
